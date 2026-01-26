import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as JSON5 from 'json5';
import { oniroLogChannel } from './utils/logger';
import { getOhosBaseSdkHome, getSupportedSdksForUi } from './utils/sdkUtils';

type CreateProjectArgs = {
	templateId: string;
	projectName: string;
	bundleName: string;
	location: string;
	sdkApi: number;
	moduleName: string;
};

type TemplateOption = {
	id: string;
	label: string;
	description: string;
	defaultModuleName: string;
};

const IGNORED_DIRS = new Set(['oh_modules', 'node_modules', 'build', '.hvigor']);

// -----------------------------------------------------------------------------
// Template helpers
// -----------------------------------------------------------------------------

/**
 * Converts a template folder name to a human friendly label.
 * @param folderName Template folder name (e.g. EmptyAbility).
 */
function toHumanTemplateName(folderName: string): string {
	return folderName.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Reads available project templates from the extension's template folder.
 * @param context Extension context used to locate templates.
 */
function getTemplateOptions(context: vscode.ExtensionContext): TemplateOption[] {
	const templateRoot = path.join(context.extensionPath, 'template');
	if (!fs.existsSync(templateRoot)) {
		return [];
	}
	const entries = fs.readdirSync(templateRoot, { withFileTypes: true });
	return entries
		.filter(e => e.isDirectory())
		.map((e) => {
			const templateDir = path.join(templateRoot, e.name);
			const metaPath = path.join(templateDir, 'template.json');
			let description = '';
			let label = toHumanTemplateName(e.name);
			let defaultModuleName = 'entry';
			if (fs.existsSync(metaPath)) {
				try {
					const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as any;
					if (typeof meta?.description === 'string') {
						description = meta.description;
					}
					if (typeof meta?.label === 'string') {
						label = meta.label;
					}
					if (typeof meta?.defaultModuleName === 'string' && meta.defaultModuleName.trim()) {
						defaultModuleName = meta.defaultModuleName.trim();
					}
				} catch {
					// Ignore invalid template metadata.
				}
			}
			return { id: e.name, label, description, defaultModuleName };
		})
		.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Validates that the selected template directory contains required files.
 * @param templateDir Absolute path to the template folder.
 * @param defaultModuleName Module name expected inside the template.
 */
function validateTemplateLayout(templateDir: string, defaultModuleName: string): string[] {
	const requiredFiles = [
		'build-profile.json5',
		path.join('AppScope', 'app.json5'),
		path.join(defaultModuleName, 'src', 'main', 'module.json5'),
		path.join(defaultModuleName, 'oh-package.json5'),
		'hvigorfile.ts'
	];

	const missing: string[] = [];
	for (const relPath of requiredFiles) {
		const absPath = path.join(templateDir, relPath);
		if (!fs.existsSync(absPath)) {
			missing.push(relPath);
		}
	}
	return missing;
}

type SdkOption = {
	version: string;
	api: number;
	installed: boolean;
};

// -----------------------------------------------------------------------------
// SDK helpers
// -----------------------------------------------------------------------------

/**
 * Converts supported SDK list into options suitable for the Create Project UI.
 */
function getSdkOptions(): SdkOption[] {
	return getSupportedSdksForUi().map((sdk) => ({
		version: sdk.version,
		api: Number(sdk.api),
		installed: sdk.installed
	}));
}

/**
 * Ensures the selected SDK API directory exists.
 * @param selectedApi SDK API version selected in the UI.
 * @returns false if the user cancels or chooses to open SDK Manager.
 */
async function ensureSelectedSdkInstalled(selectedApi: number): Promise<boolean> {
	const sdkDir = path.join(getOhosBaseSdkHome(), String(selectedApi));
	if (fs.existsSync(sdkDir)) {
		return true;
	}

	const choice = await vscode.window.showWarningMessage(
		`Selected SDK API ${selectedApi} is not installed under: ${sdkDir}.\n\nYou can install it via Oniro SDK Manager.`,
		{ modal: true },
		'Open SDK Manager',
		'Create Anyway'
	);

	if (choice === 'Open SDK Manager') {
		await vscode.commands.executeCommand('oniro-ide.openSdkManager');
		return false;
	}
	if (choice === 'Create Anyway') {
		return true;
	}
	return false;
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

/**
 * Validates project folder name (no slashes, conservative charset).
 */
function isValidProjectName(name: string): boolean {
	if (!name) {
		return false;
	}
	if (name.includes('/') || name.includes('\\')) {
		return false;
	}
	return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * Lightweight validation for bundle names (e.g. com.example.app).
 */
function isValidBundleName(bundleName: string): boolean {
	return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(bundleName);
}

// -----------------------------------------------------------------------------
// Filesystem helpers
// -----------------------------------------------------------------------------

/**
 * Async existence check for filesystem paths.
 * @param filePath Absolute path to check.
 */
async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Recursively copies a directory tree while ignoring symlinks.
 * Skips template metadata files.
 */
async function copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
	await fs.promises.mkdir(destDir, { recursive: true });
	const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
	for (const entry of entries) {
		const src = path.join(srcDir, entry.name);
		const dest = path.join(destDir, entry.name);
		if (entry.isDirectory()) {
			await copyDirRecursive(src, dest);
		} else if (entry.isSymbolicLink()) {
			// Do not follow symlinks inside the template.
			continue;
		} else if (entry.isFile()) {
			// Skip template metadata files.
			if (entry.name === 'template.json') {
				continue;
			}
			await fs.promises.copyFile(src, dest);
		}
	}
}

/**
 * Normalizes all .json5 files in a project to strict JSON for better editor support.
 * Skips heavy/generated directories.
 */
async function normalizeJson5ToJson(projectDir: string): Promise<void> {
	const stack: string[] = [projectDir];
	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) {
			continue;
		}
		const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				// Skip common heavy/generated folders if they exist
				if (IGNORED_DIRS.has(entry.name)) {
					continue;
				}
				stack.push(fullPath);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			if (!entry.name.endsWith('.json5')) {
				continue;
			}

			try {
				const parsed = readJson5File<any>(fullPath);
				writeJson5File(fullPath, parsed);
			} catch (err) {
				oniroLogChannel.appendLine(`[CreateProject] WARNING: Failed to normalize ${fullPath}: ${String(err)}`);
			}
		}
	}
}

// -----------------------------------------------------------------------------
// JSON helpers
// -----------------------------------------------------------------------------

/**
 * Reads a JSON5 file and returns parsed content.
 */
function readJson5File<T>(filePath: string): T {
	const content = fs.readFileSync(filePath, 'utf8');
	return JSON5.parse(content) as T;
}

/**
 * Writes strict JSON content to a .json5 file.
 * Fields are always quoted to keep editors and tools happy.
 */
function writeJson5File(filePath: string, value: unknown): void {
	// We intentionally write JSON (not JSON5) even when the file extension is .json5.
	// This keeps the files compatible with VS Code's built-in JSON/JSONC parser
	// (avoids red squiggles for unquoted keys) while remaining valid JSON5.
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/**
 * Reads a JSON file.
 */
function readJsonFile<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/**
 * Writes a JSON file using stable formatting.
 */
function writeJsonFile(filePath: string, value: unknown): void {
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// -----------------------------------------------------------------------------
// properties helpers
// -----------------------------------------------------------------------------

/**
 * Normalizes Windows paths for Java .properties files (escapes backslashes).
 */
function toJavaPropertiesPath(filePath: string): string {
	return process.platform === 'win32' ? filePath.replace(/\\/g, '\\\\') : filePath;
}

/**
 * Creates or overwrites local.properties with sdk.dir.
 */
function createOrUpdateLocalProperties(projectDir: string, sdkDir: string): void {
	const localPropsPath = path.join(projectDir, 'local.properties');
	const content = `sdk.dir=${toJavaPropertiesPath(sdkDir)}\n`;
	fs.writeFileSync(localPropsPath, content, 'utf8');
}
// -----------------------------------------------------------------------------
// Misc helpers
// -----------------------------------------------------------------------------

/**
 * Renames a folder if it exists and the target differs.
 */
function renameIfExists(fromPath: string, toPath: string): void {
	if (fs.existsSync(fromPath) && fromPath !== toPath) {
		fs.renameSync(fromPath, toPath);
	}
}

/**
 * Applies user selections to template files and workspace settings.
 * @param projectDir Absolute path to the created project.
 * @param args User selections from the Create Project UI.
 */
function updateTemplateConfigs(projectDir: string, args: CreateProjectArgs): void {
	// 1) AppScope/app.json5 -> bundleName
	const appJsonPath = path.join(projectDir, 'AppScope', 'app.json5');
	if (fs.existsSync(appJsonPath)) {
		const appJson = readJson5File<any>(appJsonPath);
		appJson.app = appJson.app ?? {};
		appJson.app.bundleName = args.bundleName;
		writeJson5File(appJsonPath, appJson);
	}

	// 2) App name in resources -> Project name
	const appNameStringsPath = path.join(projectDir, 'AppScope', 'resources', 'base', 'element', 'string.json');
	if (fs.existsSync(appNameStringsPath)) {
		const strings = readJsonFile<any>(appNameStringsPath);
		if (Array.isArray(strings?.string)) {
			const appName = strings.string.find((s: any) => s?.name === 'app_name');
			if (appName) {
				appName.value = args.projectName;
			}
		}
		writeJsonFile(appNameStringsPath, strings);
	}

	// 3) build-profile.json5 -> sdk + module name + srcPath
	const buildProfilePath = path.join(projectDir, 'build-profile.json5');
	if (fs.existsSync(buildProfilePath)) {
		const buildProfile = readJson5File<any>(buildProfilePath);
		buildProfile.app = buildProfile.app ?? {};
		if (Array.isArray(buildProfile.app.products) && buildProfile.app.products.length > 0) {
			buildProfile.app.products[0].compileSdkVersion = args.sdkApi;
			buildProfile.app.products[0].compatibleSdkVersion = args.sdkApi;
		}
		if (Array.isArray(buildProfile.modules) && buildProfile.modules.length > 0) {
			buildProfile.modules[0].name = args.moduleName;
			buildProfile.modules[0].srcPath = `./${args.moduleName}`;
		}
		writeJson5File(buildProfilePath, buildProfile);
	}

	// 4) module.json5 -> module.name
	const moduleJsonPath = path.join(projectDir, args.moduleName, 'src', 'main', 'module.json5');
	if (fs.existsSync(moduleJsonPath)) {
		const moduleJson = readJson5File<any>(moduleJsonPath);
		moduleJson.module = moduleJson.module ?? {};
		moduleJson.module.name = args.moduleName;
		writeJson5File(moduleJsonPath, moduleJson);
	}

	// 5) module oh-package.json5 -> name
	const moduleOhPackagePath = path.join(projectDir, args.moduleName, 'oh-package.json5');
	if (fs.existsSync(moduleOhPackagePath)) {
		const modulePkg = readJson5File<any>(moduleOhPackagePath);
		modulePkg.name = args.moduleName;
		writeJson5File(moduleOhPackagePath, modulePkg);
	}

	// 6) Workspace settings for Oniro (hapPath)
	const vscodeDir = path.join(projectDir, '.vscode');
	fs.mkdirSync(vscodeDir, { recursive: true });
	const hapPath = `${args.moduleName}/build/default/outputs/default/${args.moduleName}-default-signed.hap`;
	writeJsonFile(path.join(vscodeDir, 'settings.json'), {
		'oniro.hapPath': hapPath,
		'files.associations': {
			'*.json5': 'jsonc'
		}
	});

	// 7) local.properties
	// IMPORTANT: hvigor expects sdk.dir to point to the SDK *base* directory (the folder containing API subfolders),
	// not to the API folder itself. If sdk.dir points to .../<api>, hvigor will effectively look for .../<api>/<api>/... and fail.
	const sdkBaseDir = getOhosBaseSdkHome();
	createOrUpdateLocalProperties(projectDir, sdkBaseDir);
}

/**
 * Creates a project directory from a template and updates configuration files.
 * @param context Extension context used to locate templates.
 * @param args User selections from the Create Project UI.
 */
async function createProjectFromTemplate(context: vscode.ExtensionContext, args: CreateProjectArgs): Promise<string> {
	const templateRoot = path.join(context.extensionPath, 'template');
	const templateDir = path.join(templateRoot, args.templateId);
	if (!(await pathExists(templateDir))) {
		throw new Error(`Template not found: ${templateDir}`);
	}

	// Validate template structure early.
	const options = getTemplateOptions(context);
	const selected = options.find(t => t.id === args.templateId);
	const defaultModuleName = selected?.defaultModuleName ?? 'entry';
	const missing = validateTemplateLayout(templateDir, defaultModuleName);
	if (missing.length > 0) {
		throw new Error(`Template '${args.templateId}' is missing required files:\n- ${missing.join('\n- ')}`);
	}

	const location = args.location;
	if (!(await pathExists(location))) {
		throw new Error(`Location does not exist: ${location}`);
	}

	const projectDir = path.join(location, args.projectName);
	if (await pathExists(projectDir)) {
		const answer = await vscode.window.showWarningMessage(
			`Folder already exists: ${projectDir}. Overwrite its contents?`,
			{ modal: true },
			'Overwrite'
		);
		if (answer !== 'Overwrite') {
			throw new Error('Cancelled by user');
		}
		await fs.promises.rm(projectDir, { recursive: true, force: true });
	}

	await copyDirRecursive(templateDir, projectDir);

	// If user changed module name, rename directory first.
	if (args.moduleName !== defaultModuleName) {
		renameIfExists(path.join(projectDir, defaultModuleName), path.join(projectDir, args.moduleName));
	}

	updateTemplateConfigs(projectDir, args);
	await normalizeJson5ToJson(projectDir);

	return projectDir;
}

/**
 * Reads the Create Project webview HTML from the packaged output folder.
 */
function getWebviewHtml(context: vscode.ExtensionContext): string {
	const htmlPath = path.join(context.extensionPath, 'out', 'createProjectWebview.html');
	try {
		return fs.readFileSync(htmlPath, 'utf8');
	} catch (err) {
		return `<html><body><h2>Failed to load Create Project UI</h2><pre>${String(err)}</pre></body></html>`;
	}
}

/**
 * Registers the "Oniro: Create Project" command and its webview flow.
 */
export function registerCreateProjectCommand(context: vscode.ExtensionContext): void {
	const disposable = vscode.commands.registerCommand('oniro-ide.createProject', async () => {
		const panel = vscode.window.createWebviewPanel(
			'oniroCreateProject',
			'Oniro: Create Project',
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);

		panel.webview.html = getWebviewHtml(context);

		const templateOptions = getTemplateOptions(context);
		const sdkOptions = getSdkOptions();
		const supportedApis = new Set(sdkOptions.map(s => s.api));
		// Prefer the latest installed SDK; otherwise fall back to the latest available.
		const defaultSdkApi = sdkOptions.find(s => s.installed)?.api ?? sdkOptions[0]?.api ?? 12;
		const defaultTemplateId = templateOptions.find(t => t.id === 'EmptyAbility')?.id ?? templateOptions[0]?.id ?? 'EmptyAbility';
		const defaultTemplateModuleName = templateOptions.find(t => t.id === defaultTemplateId)?.defaultModuleName ?? 'entry';

		const defaults: CreateProjectArgs = {
			templateId: defaultTemplateId,
			projectName: 'MyApplication',
			bundleName: 'com.example.myapplication',
			location: os.homedir(),
			sdkApi: defaultSdkApi,
			moduleName: defaultTemplateModuleName
		};

		const readyListener = panel.webview.onDidReceiveMessage((message) => {
			if (message?.command === 'webviewReady') {
				panel.webview.postMessage({ command: 'init', defaults, sdkOptions, templateOptions });
				readyListener.dispose();
			}
		});

		panel.webview.onDidReceiveMessage(async (message) => {
			try {
				if (message?.command === 'pickLocation') {
					const picked = await vscode.window.showOpenDialog({
						canSelectFiles: false,
						canSelectFolders: true,
						canSelectMany: false,
						defaultUri: vscode.Uri.file(os.homedir()),
						openLabel: 'Select Location'
					});
					if (picked && picked[0]) {
						panel.webview.postMessage({ command: 'locationPicked', location: picked[0].fsPath });
					}
					return;
				}

				if (message?.command === 'createProject') {
					panel.webview.postMessage({ command: 'clearError' });

					const args: CreateProjectArgs = {
						templateId: String(message.templateId ?? '').trim(),
						projectName: String(message.projectName ?? '').trim(),
						bundleName: String(message.bundleName ?? '').trim(),
						location: String(message.location ?? '').trim(),
						sdkApi: Number(message.sdkApi),
						moduleName: String(message.moduleName ?? 'entry').trim() || 'entry'
					};

					if (!args.templateId) {
						panel.webview.postMessage({ command: 'setError', message: 'Please select a template.' });
						return;
					}

					if (!isValidProjectName(args.projectName)) {
						panel.webview.postMessage({ command: 'setError', message: 'Invalid project name. Use letters/numbers/._- and no slashes.' });
						return;
					}
					if (!isValidBundleName(args.bundleName)) {
						panel.webview.postMessage({ command: 'setError', message: 'Invalid bundle name. Example: com.example.myapplication' });
						return;
					}
					if (!args.location) {
						panel.webview.postMessage({ command: 'setError', message: 'Please select a location.' });
						return;
					}
					if (!args.moduleName || args.moduleName.includes('/') || args.moduleName.includes('\\')) {
						panel.webview.postMessage({ command: 'setError', message: 'Invalid module name.' });
						return;
					}
					if (!supportedApis.has(args.sdkApi)) {
						panel.webview.postMessage({ command: 'setError', message: 'Unsupported SDK selection.' });
						return;
					}

					if (!(await ensureSelectedSdkInstalled(args.sdkApi))) {
						// User chose to open SDK Manager or cancelled.
						return;
					}

					oniroLogChannel.appendLine(`[CreateProject] Creating project '${args.projectName}' at '${args.location}'`);
					const createdProjectDir = await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: 'Oniro: Creating project…',
							cancellable: false
						},
						() => createProjectFromTemplate(context, args)
					);

					// Open immediately in the same window (no extra confirmation dialog).
					panel.dispose();
					await vscode.commands.executeCommand(
						'vscode.openFolder',
						vscode.Uri.file(createdProjectDir),
						{ forceReuseWindow: true }
					);
				}
			} catch (err) {
				const messageText = err instanceof Error ? err.message : String(err);
				if (messageText === 'Cancelled by user') {
					return;
				}
				oniroLogChannel.appendLine(`[CreateProject] ERROR: ${messageText}`);
				panel.webview.postMessage({ command: 'setError', message: messageText });
			}
		});
	});

	context.subscriptions.push(disposable);
}
