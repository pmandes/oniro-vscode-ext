import * as fs from 'fs';
import * as path from 'path';
import * as JSON5 from 'json5';
import * as os from 'os';
import { https, http } from 'follow-redirects';
import { pipeline } from 'stream';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as tar from 'tar';
import extractZip from 'extract-zip';
import { oniroLogChannel } from '../utils/logger';
import * as vscode from 'vscode';

// ZIP extraction with progress using node-stream-zip (lazy require to avoid hard dependency at runtime until used)
async function extractZipWithProgress(zipPath: string, dest: string, progress?: vscode.Progress<{message?: string, increment?: number}>): Promise<void> {
    // require here to avoid import-time errors if module not installed
    // node-stream-zip provides an async API via .async
        // use `unzipper` to iterate entries and report progress
        const unzipper = require('unzipper');
        const dir = await unzipper.Open.file(zipPath);
        const files = dir.files || [];
        const total = files.length || 1;
        let processed = 0;
        let lastPercent = 0;
        await fs.promises.mkdir(dest, { recursive: true });
        for (const file of files) {
            const entryName = file.path as string;
            const targetPath = path.join(dest, entryName);
            if (file.type === 'Directory') {
                await fs.promises.mkdir(targetPath, { recursive: true });
            } else {
                await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
                const readStream = file.stream();
                const writeStream = fs.createWriteStream(targetPath);
                await pipelineAsync(readStream as any, writeStream);
            }
            processed++;
            if (progress) {
                const percent = Math.min(100, Math.round((processed / total) * 100));
                const inc = percent - lastPercent;
                if (inc > 0) {
                    progress.report?.({ message: `Extracting: ${percent}%`, increment: inc });
                    lastPercent = percent;
                } else {
                    progress.report?.({ message: `Extracting: ${percent}%`, increment: 0 });
                }
            }
        }
}

/**
 * Prompts the user to select a ZIP file and installs the command line tools from it.
 * Used when no download URL is configured for Windows/Mac.
 */
export async function manualInstallCmdTools(progress?: vscode.Progress<{message?: string, increment?: number}>, abortSignal?: AbortSignal): Promise<void> {
    // Prompt for ZIP file
    vscode.window.showInformationMessage('No download URL is configured for command line tools on this OS. Please download the ZIP manually and select it for installation.');
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select ZIP file',
        filters: { 'ZIP files': ['zip'] }
    });
    if (!uris || uris.length === 0) {
        throw new Error('No ZIP file selected.');
    }
    const zipPath = uris[0].fsPath;

    // Internal worker to perform extraction and installation using provided progress
    const doInstall = async (p?: vscode.Progress<{message?: string, increment?: number}>, signal?: AbortSignal) => {
        const CMD_PATH = getCmdToolsPath();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cmdtools-'));
        const extractPath = path.join(tmpDir, 'oh-command-line-tools');
        try {
            if (p) { p.report?.({ message: 'Extracting tools...', increment: 0 }); }
            await extractZipWithProgress(zipPath, extractPath, p);
            if (signal?.aborted) { throw new Error('Download cancelled'); }
            fs.mkdirSync(CMD_PATH, { recursive: true });
            const srcDir = findCmdToolsSourceDir(extractPath);
            for (const entry of fs.readdirSync(srcDir)) {
                if (signal?.aborted) { throw new Error('Download cancelled'); }
                const src = path.join(srcDir, entry);
                const dest = path.join(CMD_PATH, entry);
                if (fs.statSync(src).isDirectory()) {
                    if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); }
                    fs.renameSync(src, dest);
                } else {
                    fs.copyFileSync(src, dest);
                }
            }
            const binDir = path.join(CMD_PATH, 'bin');
            if (fs.existsSync(binDir) && os.platform() !== 'win32') {
                for (const file of fs.readdirSync(binDir)) {
                    fs.chmodSync(path.join(binDir, file), 0o755);
                }
            }
            if (p) { p.report?.({ message: 'Cleaning up...', increment: 0 }); }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (err) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            throw err;
        }
    };

    // If caller provided a progress object (e.g. sdkManager.withProgress), use it.
    if (progress) {
        await doInstall(progress, abortSignal);
        return;
    }

    // Otherwise show our own progress notification so user sees extraction progress.
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Installing OpenHarmony Command Line Tools',
        cancellable: true
    }, async (p, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        await doInstall(p, controller.signal);
    });

    // After successful manual install show information and try to open/refresh SDK Manager
    vscode.window.showInformationMessage(`Command line tools installed to: ${getCmdToolsPath()}`);
    // Try to open SDK Manager so the UI reflects the new installation; if already open, this will focus it.
    try { await vscode.commands.executeCommand('oniro-ide.openSdkManager'); } catch (_) {}
}

export interface SdkInfo {
    version: string;
    api: string;
    installed: boolean;
}

/**
 * Returns the list of SDKs known to this extension UI,
 * annotated with installation status for the current OS folder.
 *
 * NOTE: Do not filter out older API levels here; the Create Project UI should
 * stay in sync with SDK Manager.
 */
export function getSupportedSdksForUi(): SdkInfo[] {
    const base = getOhosBaseSdkHome();
    return ALL_SDKS
        .map((sdk) => {
            const sdkDir = path.join(base, String(sdk.api));
            return { version: sdk.version, api: sdk.api, installed: fs.existsSync(sdkDir) };
        })
        .sort((a, b) => Number(b.api) - Number(a.api));
}

// Get Oniro SDK root and command tools path from configuration, with fallback to defaults
function getOniroConfig<T = string>(key: string, fallback: T): T {
    const config = vscode.workspace.getConfiguration('oniro');
    let value = config.get<T>(key);
    if (typeof value === 'string' && value.includes('${userHome}')) {
        value = value.replace(/\$\{userHome\}/g, os.homedir()) as T;
    }
    return (value === undefined || value === null || value === "") ? fallback : value;
}

// Determine OS folder for SDK path
function getOsFolder(): string {
  const platform = os.platform();
    if (platform === 'linux') { return 'linux'; }
    if (platform === 'darwin') { return 'darwin'; }
    if (platform === 'win32') { return 'windows'; }
  throw new Error('Unsupported OS');
}

export function getSdkRootDir(): string {
    return getOniroConfig('sdkRootDir', path.join(os.homedir(), 'setup-ohos-sdk'));
}

export function getOhosBaseSdkHome(): string {
    return path.join(getSdkRootDir(), getOsFolder());
}

export function getCmdToolsPath(): string {
    return getOniroConfig('cmdToolsPath', path.join(os.homedir(), 'command-line-tools'));
}

function getExistingFilePath(candidates: string[]): string {
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) { return candidate; }
    }
    return candidates[0];
}

export function getCmdToolsBin(): string {
    const binDir = path.join(getCmdToolsPath(), 'bin');
    const platform = os.platform();
    if (platform === 'win32') {
        return getExistingFilePath([
            path.join(binDir, 'ohpm.exe'),
            path.join(binDir, 'ohpm.cmd'),
            path.join(binDir, 'ohpm.bat'),
            path.join(binDir, 'ohpm')
        ]);
    }
    return path.join(binDir, 'ohpm');
}

// Helper to get the full hdc executable path
export function getHdcPath(): string {
    // hdc is located in ./sdk/default/openharmony/toolchains/hdc relative to getCmdToolsPath()
    const base = path.join(getCmdToolsPath(), 'sdk', 'default', 'openharmony', 'toolchains');
    if (os.platform() === 'win32') {
        return getExistingFilePath([
            path.join(base, 'hdc.exe'),
            path.join(base, 'hdc.bat'),
            path.join(base, 'hdc.cmd'),
            path.join(base, 'hdc')
        ]);
    }
    return path.join(base, 'hdc');
}

export const ALL_SDKS = [
    { version: '4.0', api: '10' },
    { version: '4.1', api: '11' },
    { version: '5.0.0', api: '12' },
    { version: '5.0.1', api: '13' },
    { version: '5.0.2', api: '14' },
    { version: '5.0.3', api: '15' },
    { version: '5.1.0', api: '18' },
    { version: '6.0', api: '20' }
];

export function getInstalledSdks(): string[] {
    const sdkRoot = getSdkRootDir();
    const versions = new Set<string>();
    if (!fs.existsSync(sdkRoot)) { return []; }
    for (const osFolder of ['linux', 'darwin', 'windows']) {
        const osPath = path.join(sdkRoot, osFolder);
        if (!fs.existsSync(osPath) || !fs.statSync(osPath).isDirectory()) { continue; }
        for (const api of fs.readdirSync(osPath)) {
            const apiPath = path.join(osPath, api);
            if (!fs.statSync(apiPath).isDirectory()) { continue; }
            versions.add(api);
        }
    }
    return ALL_SDKS.filter(sdk => versions.has(sdk.api)).map(sdk => sdk.version);
}


export function isCmdToolsInstalled(): boolean {
    return fs.existsSync(getCmdToolsBin());
}

export function getCmdToolsStatus(): { installed: boolean, status: string } {
    if (isCmdToolsInstalled()) {
        // Prefer reading explicit version.txt '# Version: x.y.z' if present
        try {
            const versionFile = path.join(getCmdToolsPath(), 'version.txt');
            if (fs.existsSync(versionFile)) {
                const content = fs.readFileSync(versionFile, 'utf8');
                const lines = content.split(/\r?\n/);
                for (const line of lines) {
                    const m = line.match(/^\s*#\s*Version:\s*(.+)$/);
                    if (m && m[1]) {
                        const ver = m[1].trim();
                        return { installed: true, status: `Installed (${ver})` };
                    }
                }
            }
        } catch (e) {
            // ignore and continue to try executing the binary
        }

        try {
            const version = require('child_process').execFileSync(getCmdToolsBin(), ['-v'], { encoding: 'utf8' }).trim();
            return { installed: true, status: `Installed (${version})` };
        } catch {
            return { installed: true, status: 'Installed (version unknown)' };
        }
    } else {
        return { installed: false, status: 'Not installed' };
    }
}

const pipelineAsync = promisify(pipeline);

export async function downloadFile(url: string, dest: string, progress?: vscode.Progress<{message?: string, increment?: number}>, abortSignal?: AbortSignal): Promise<void> {
    const proto = url.startsWith('https') ? https : http;
    return new Promise((resolve, reject) => {
        if (abortSignal?.aborted) {
            reject(new Error('Download cancelled'));
            return;
        }
        const file = fs.createWriteStream(dest);
        const req = proto.get(url, response => {
            if (response.statusCode !== 200) {
                oniroLogChannel.appendLine(`[SDK] Failed to get '${url}' (${response.statusCode})`);
                reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
                return;
            }
            const total = parseInt(response.headers['content-length'] || '0', 10);
            let downloaded = 0;
            let lastPercent = 0;
            response.on('data', chunk => {
                downloaded += chunk.length;
                if (progress && total) {
                    const percent = Math.min(100, Math.round((downloaded / total) * 100));
                    if (percent > lastPercent) {
                        // @ts-ignore
                        progress.report?.({ message: `Downloading: ${percent}%`, increment: percent - lastPercent });
                        lastPercent = percent;
                    }
                }
            });
            response.pipe(file);
            file.on('finish', () => file.close((err) => err ? reject(err) : resolve()));
            abortSignal?.addEventListener('abort', () => {
                response.destroy();
                file.close();
                fs.unlink(dest, () => {});
                reject(new Error('Download cancelled'));
            });
        }).on('error', (err) => {
            oniroLogChannel.appendLine(`[SDK] Error downloading '${url}': ${err.message}`);
            reject(err);
        });
        abortSignal?.addEventListener('abort', () => {
            req.destroy();
            file.close();
            fs.unlink(dest, () => {});
            reject(new Error('Download cancelled'));
        });
    });
}

export async function verifySha256(filePath: string, sha256Path: string): Promise<void> {
    const expected = fs.readFileSync(sha256Path, 'utf8').split(/\s+/)[0];
    const hash = crypto.createHash('sha256');
    const fileStream = fs.createReadStream(filePath);
    await pipelineAsync(fileStream, hash);
    const actual = hash.digest('hex');
    if (actual !== expected) {
        throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
    }
}

export async function extractTarball(tarPath: string, dest: string, strip: number): Promise<void> {
    await tar.x({ file: tarPath, cwd: dest, strip });
}

export function getSdkFilename(version?: string): { filename: string, osFolder: string, strip: number } {
    const platform = os.platform();
    // Default to latest if version not provided
    const v = version || ALL_SDKS[ALL_SDKS.length - 1].version;
    if (platform === 'linux') {
        // For 5.0.0 and 5.0.1, do not strip components
        const strip = (v === '5.0.0' || v === '5.0.1' || v === '6.0') ? 0 : 1;
        return { filename: 'ohos-sdk-windows_linux-public.tar.gz', osFolder: 'linux', strip };
    } else if (platform === 'darwin') {
        // Always strip 3 for mac
        if (os.arch() === 'arm64') {
            return { filename: 'L2-SDK-MAC-M1-PUBLIC.tar.gz', osFolder: 'darwin', strip: 3 };
        } else {
            return { filename: 'ohos-sdk-mac-public.tar.gz', osFolder: 'darwin', strip: 3 };
        }
    } else if (platform === 'win32') {
        // For 5.0.0 and 5.0.1, do not strip components
        const strip = (v === '5.0.0' || v === '5.0.1' || v === '6.0') ? 0 : 1;
        return { filename: 'ohos-sdk-windows_linux-public.tar.gz', osFolder: 'windows', strip };
    } else {
        throw new Error('Unsupported OS');
    }
}

export async function downloadAndInstallSdk(version: string, api: string, progress?: vscode.Progress<{message?: string, increment?: number}>, abortSignal?: AbortSignal): Promise<void> {
    const { filename, osFolder, strip } = getSdkFilename(version);
    const urlBase = 'https://repo.huaweicloud.com/openharmony/os';
    const downloadUrl = `${urlBase}/${version}-Release/${filename}`;
    const sha256Url = `${downloadUrl}.sha256`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdk-'));
    const tarPath = path.join(tmpDir, filename);
    const sha256Path = path.join(tmpDir, filename + '.sha256');
    const extractDir = path.join(tmpDir, 'extract');
    fs.mkdirSync(extractDir);
    const sdkInstallDir = path.join(getSdkRootDir(), osFolder, api);
    fs.mkdirSync(path.dirname(sdkInstallDir), { recursive: true });
    try {
        if (progress) { progress.report?.({ message: 'Downloading SDK archive...', increment: 0 }); }
        await downloadFile(downloadUrl, tarPath, progress, abortSignal);
        if (progress) { progress.report?.({ message: 'Downloading checksum...', increment: 0 }); }
        await downloadFile(sha256Url, sha256Path, progress, abortSignal);
        if (progress) { progress.report?.({ message: 'Verifying checksum...', increment: 0 }); }
        await verifySha256(tarPath, sha256Path);
        if (progress) { progress.report?.({ message: 'Extracting SDK (this may take a while)...', increment: 0 }); }
        await extractTarball(tarPath, extractDir, strip);
        if (progress) { progress.report?.({ message: 'Extracting SDK components (this may take a while)...', increment: 0 }); }
        const osContentPath = path.join(extractDir, osFolder);
        const zipFiles = fs.readdirSync(osContentPath).filter(name => name.endsWith('.zip'));
        for (const zipFile of zipFiles) {
            oniroLogChannel.appendLine(`[SDK] Extracting component ${zipFile}`);
            const zipPath = path.join(osContentPath, zipFile);
            await extractZip(zipPath, { dir: osContentPath });
            fs.unlinkSync(zipPath);
        }
        if (progress) { progress.report?.({ message: 'Finalizing installation...', increment: 0 }); }
        const osPath = path.join(extractDir, osFolder);
        if (!fs.existsSync(osPath)) {
            throw new Error(`Expected folder '${osFolder}' not found in extracted SDK. Extraction may have failed or the archive structure is unexpected.`);
        }
        if (fs.existsSync(sdkInstallDir)) { fs.rmSync(sdkInstallDir, { recursive: true, force: true }); }
        fs.renameSync(osPath, sdkInstallDir);
        if (progress) { progress.report?.({ message: 'Cleaning up...', increment: 0 }); }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
        oniroLogChannel.appendLine(`[SDK] ERROR: ${err instanceof Error ? err.message : String(err)}`);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw err;
    }
}

function getCmdToolsDownloadUrl(): string {
    const config = vscode.workspace.getConfiguration('oniro');
    const platform = os.platform();
    if (platform === 'linux') {
        return config.get<string>('cmdToolsUrlLinux')
            || 'https://repo.huaweicloud.com/harmonyos/ohpm/5.1.0/commandline-tools-linux-x64-5.1.0.840.zip';
    }
    if (platform === 'win32') {
        const url = config.get<string>('cmdToolsUrlWindows');
        if (url) { return url; }
        throw new Error('Command line tools URL for Windows is not configured. Set oniro.cmdToolsUrlWindows.');
    }
    if (platform === 'darwin') {
        const url = config.get<string>('cmdToolsUrlMac');
        if (url) { return url; }
        throw new Error('Command line tools URL for macOS is not configured. Set oniro.cmdToolsUrlMac.');
    }
    throw new Error('Unsupported OS for command line tools.');
}

function findCmdToolsSourceDir(extractPath: string): string {
    const known = [
        path.join(extractPath, 'command-line-tools'),
        path.join(extractPath, 'oh-command-line-tools'),
        path.join(extractPath, 'commandline-tools')
    ];
    for (const candidate of known) {
        if (fs.existsSync(candidate)) { return candidate; }
    }
    const entries = fs.readdirSync(extractPath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(extractPath, e.name));
    for (const dir of entries) {
        if (fs.existsSync(path.join(dir, 'bin'))) { return dir; }
    }
    throw new Error('Could not locate command line tools folder in the extracted archive.');
}

export async function installCmdTools(progress?: vscode.Progress<{message?: string, increment?: number}>, abortSignal?: AbortSignal): Promise<void> {
    const CMD_PATH = getCmdToolsPath();
    let url: string | undefined;
    try {
        url = getCmdToolsDownloadUrl();
    } catch (e) {
        // No URL configured for this OS, fall back to manual install
        await manualInstallCmdTools(progress, abortSignal);
        return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cmdtools-'));
    const zipPath = path.join(tmpDir, 'oh-command-line-tools.zip');
    const extractPath = path.join(tmpDir, 'oh-command-line-tools');
    try {
        if (progress) { progress.report?.({ message: 'Downloading command line tools...', increment: 0 }); }
        await downloadFile(url, zipPath, progress, abortSignal);
        if (progress) { progress.report?.({ message: 'Extracting tools...', increment: 0 }); }
        await extractZipWithProgress(zipPath, extractPath, progress);
        fs.mkdirSync(CMD_PATH, { recursive: true });
        const srcDir = findCmdToolsSourceDir(extractPath);
        for (const entry of fs.readdirSync(srcDir)) {
            const src = path.join(srcDir, entry);
            const dest = path.join(CMD_PATH, entry);
            if (fs.statSync(src).isDirectory()) {
                if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); }
                fs.renameSync(src, dest);
            } else {
                fs.copyFileSync(src, dest);
            }
        }
        const binDir = path.join(CMD_PATH, 'bin');
        if (fs.existsSync(binDir) && os.platform() !== 'win32') {
            for (const file of fs.readdirSync(binDir)) {
                fs.chmodSync(path.join(binDir, file), 0o755);
            }
        }
        if (progress) { progress.report?.({ message: 'Cleaning up...', increment: 0 }); }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw err;
    }
}

export function removeCmdTools(): void {
    if (fs.existsSync(getCmdToolsPath())) {
        fs.rmSync(getCmdToolsPath(), { recursive: true, force: true });
    }
}

/**
 * Removes the SDK for the given API version from all OS folders.
 * Returns true if any SDK was removed, false otherwise.
 */
export function removeSdk(api: string): boolean {
    const osFolders = ['linux', 'darwin', 'windows'];
    let removed = false;
    for (const osFolder of osFolders) {
        const sdkPath = path.join(getSdkRootDir(), osFolder, api);
        if (fs.existsSync(sdkPath)) {
            fs.rmSync(sdkPath, { recursive: true, force: true });
            removed = true;
        }
    }
    return removed;
}

// Get Oniro Emulator directory from configuration, with fallback to ~/oniro-emulator
export function getEmulatorDir(): string {
    return getOniroConfig('emulatorDir', path.join(os.homedir(), 'oniro-emulator'));
}

/**
 * Checks if the emulator is installed (by checking for run.sh in images/).
 */
export function isEmulatorInstalled(): boolean {
    const emulatorRunSh = path.join(getEmulatorDir(), 'images', 'run.sh');
    return fs.existsSync(emulatorRunSh);
}

/**
 * Installs the Oniro emulator by downloading and extracting it.
 */
export async function installEmulator(
    progress?: vscode.Progress<{message?: string, increment?: number}>,
    abortSignal?: AbortSignal
): Promise<void> {
    const EMULATOR_URL = getOniroConfig(
        'emulatorUrl',
        'https://github.com/eclipse-oniro4openharmony/device_board_oniro/releases/latest/download/oniro_emulator.zip'
    );
    const EMULATOR_DIR = getEmulatorDir();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-emulator-'));
    const tmpZip = path.join(tmpDir, 'oniro_emulator.zip');
    try {
        fs.mkdirSync(EMULATOR_DIR, { recursive: true });
        if (progress) { progress.report?.({ message: 'Downloading emulator...', increment: 0 }); }
        await downloadFile(EMULATOR_URL, tmpZip, progress, abortSignal);
        if (progress) { progress.report?.({ message: 'Extracting emulator...', increment: 0 }); }
        await extractZipWithProgress(tmpZip, EMULATOR_DIR, progress);
        const runSh = path.join(EMULATOR_DIR, 'images', 'run.sh');
        if (fs.existsSync(runSh)) {
            fs.chmodSync(runSh, 0o755);
        }
        if (progress) { progress.report?.({ message: 'Cleaning up...', increment: 0 }); }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw err;
    }
}

/**
 * Removes the Oniro emulator directory.
 */
export function removeEmulator(): void {
    const EMULATOR_DIR = getEmulatorDir();
    if (fs.existsSync(EMULATOR_DIR)) {
        fs.rmSync(EMULATOR_DIR, { recursive: true, force: true });
    }
}

/**
 * Detects the project SDK version by reading the compileSdkVersion field from build-profile.json5 at the project root.
 * @param projectRoot The absolute path to the project root directory.
 * @returns The compileSdkVersion as a number, or undefined if not found or on error.
 */
export function detectProjectSdkVersion(projectRoot: string): number | undefined {
    try {
        const buildProfilePath = path.join(projectRoot, 'build-profile.json5');
        if (!fs.existsSync(buildProfilePath)) {
            oniroLogChannel.appendLine(`build-profile.json5 not found at ${projectRoot}`);
            return undefined;
        }
        const fileContent = fs.readFileSync(buildProfilePath, 'utf-8');
        const config = JSON5.parse(fileContent);
        const products = config?.app?.products;
        if (Array.isArray(products) && products.length > 0) {
            const compileSdkVersion = products[0]?.compileSdkVersion;
            if (typeof compileSdkVersion === 'number') {
                return compileSdkVersion;
            }
        }
        return undefined;
    } catch (err) {
        oniroLogChannel.appendLine(`Error reading build-profile.json5 at ${projectRoot}: ${err}`);
        return undefined;
    }
}