import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as json5 from 'json5';
import { oniroLogChannel } from './utils/logger';
import { onirobuilderBuildWithParams } from './utils/onirobuilder';

type BuildProfile = {
	app?: {
		products?: Array<{ name: string; signingConfig?: string }>;
		buildModeSet?: Array<{ name: string }>;
		signingConfigs?: Array<Record<string, unknown>>;
	};
	modules?: Array<{ name: string; srcPath?: string }>;
};

type OhPackage = Record<string, unknown>;

function readJson5File<T>(filePath: string): T {
	const content = fs.readFileSync(filePath, 'utf8');
	return json5.parse(content) as T;
}

function getWorkspaceRoot(): string {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		throw new Error('No workspace folder found.');
	}
	return workspaceFolders[0].uri.fsPath;
}

function loadBuildProfile(projectDir: string): BuildProfile {
	const buildProfilePath = path.join(projectDir, 'build-profile.json5');
	if (!fs.existsSync(buildProfilePath)) {
		throw new Error('build-profile.json5 not found.');
	}
	return readJson5File<BuildProfile>(buildProfilePath);
}

function loadRootOhPackage(projectDir: string): OhPackage | undefined {
	const ohPackagePath = path.join(projectDir, 'oh-package.json5');
	if (!fs.existsSync(ohPackagePath)) {
		return undefined;
	}
	return readJson5File<OhPackage>(ohPackagePath);
}

function loadModuleOhPackage(projectDir: string, moduleName: string): OhPackage | undefined {
	const ohPackagePath = path.join(projectDir, moduleName, 'oh-package.json5');
	if (!fs.existsSync(ohPackagePath)) {
		return undefined;
	}
	return readJson5File<OhPackage>(ohPackagePath);
}

function getBuildConfigHtml(context: vscode.ExtensionContext): string {
	const outPath = path.join(context.extensionPath, 'out', 'buildConfigWebview.html');
	if (fs.existsSync(outPath)) {
		return fs.readFileSync(outPath, 'utf8');
	}
	const srcPath = path.join(context.extensionPath, 'src', 'buildConfigWebview.html');
	if (fs.existsSync(srcPath)) {
		return fs.readFileSync(srcPath, 'utf8');
	}
	throw new Error('buildConfigWebview.html not found in out/ or src/.');
}

export function registerBuildConfigCommand(context: vscode.ExtensionContext): void {
	const disposable = vscode.commands.registerCommand('oniro-ide.build', async () => {
		try {
			oniroLogChannel.appendLine('[BuildConfig] Opening build configuration panel.');
			const projectDir = getWorkspaceRoot();
			const buildProfile = loadBuildProfile(projectDir);
			const rootPackage = loadRootOhPackage(projectDir);

			const modulesDetails = buildProfile.modules ?? [];
			const modules = modulesDetails.map(m => m.name).filter(Boolean);
			const productsDetails = buildProfile.app?.products ?? [];
			const products = productsDetails.map(p => p.name).filter(Boolean);
			const buildModes = (buildProfile.app?.buildModeSet ?? []).map(m => m.name).filter(Boolean);
			const signingConfigs = buildProfile.app?.signingConfigs ?? [];

			const defaultModule = modules[0] ?? 'entry';
			const defaultProduct = products[0] ?? 'default';
			const defaultBuildMode = buildModes[0] ?? 'debug';

			const modulePackages: Record<string, OhPackage | undefined> = {};
			for (const mod of modules) {
				modulePackages[mod] = loadModuleOhPackage(projectDir, mod);
			}

			const panel = vscode.window.createWebviewPanel(
				'oniroBuildConfig',
				'Oniro: Build Configuration',
				vscode.ViewColumn.One,
				{ enableScripts: true }
			);

			panel.webview.html = getBuildConfigHtml(context);
			panel.webview.onDidReceiveMessage(async message => {
				if (message?.command === 'webviewReady') {
					panel.webview.postMessage({
						command: 'init',
						data: {
							modules,
							modulesDetails,
							products,
							productsDetails,
							buildModes,
							signingConfigs,
							rootPackage,
							modulePackages,
							defaults: {
								module: defaultModule,
								product: defaultProduct,
								buildMode: defaultBuildMode
							}
						}
					});
				}
				if (message?.command === 'build') {
					try {
						await onirobuilderBuildWithParams({
							product: message?.data?.product,
							module: message?.data?.module,
							buildMode: message?.data?.buildMode
						});
						vscode.window.showInformationMessage('Build started.');
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						vscode.window.showErrorMessage(`Build failed: ${errMsg}`);
					}
				}
			}, undefined, context.subscriptions);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			oniroLogChannel.appendLine(`[BuildConfig] ${message}`);
			vscode.window.showErrorMessage(message);
		}
	});

	context.subscriptions.push(disposable);
}