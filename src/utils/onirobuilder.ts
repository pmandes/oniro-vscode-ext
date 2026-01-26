import * as vscode from 'vscode';
import { oniroLogChannel } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import * as json5 from 'json5';
import { getCmdToolsPath, getOhosBaseSdkHome } from './sdkUtils';
import { generateSigningConfigs } from './generate_signing_configs';

const workspaceFolders = vscode.workspace.workspaceFolders;
const projectDir = workspaceFolders && workspaceFolders.length > 0
  ? workspaceFolders[0].uri.fsPath
  : process.cwd();

const logChannel = oniroLogChannel;

function getHvigorwPath(projectDirPath: string): string {
  const cmdToolsBin = path.join(getCmdToolsPath(), 'bin');
  let hvigorwPath = path.join(projectDirPath, 'hvigorw');
  if (!fs.existsSync(hvigorwPath)) {
    hvigorwPath = path.join(cmdToolsBin, 'hvigorw');
  }
  return hvigorwPath;
}

async function ensureSigningConfigs(): Promise<void> {
  const buildProfilePath = path.join(projectDir, 'build-profile.json5');
  if (fs.existsSync(buildProfilePath)) {
    try {
      const content = fs.readFileSync(buildProfilePath, 'utf8');
      const profile = json5.parse(content);
      if (
        !profile?.app?.signingConfigs ||
        !Array.isArray(profile.app.signingConfigs) ||
        profile.app.signingConfigs.length === 0
      ) {
        vscode.window.showWarningMessage(
          'No signing configs found in build-profile.json5. Please generate them first using the Oniro: Sign App command.'
        );
        throw new Error('Missing signing configs in build-profile.json5');
      }
    } catch (err) {
      logChannel.appendLine(`[onirobuilder] Error reading/parsing build-profile.json5: ${err}`);
      vscode.window.showWarningMessage(
        'Could not read or parse build-profile.json5. Please ensure it exists and is valid, and generate signing configs if needed.'
      );
      throw err;
    }
  } else {
    vscode.window.showWarningMessage(
      'build-profile.json5 not found. Please generate signing configs first using the Oniro: Sign App command.'
    );
    throw new Error('build-profile.json5 not found');
  }
}

async function runTaskAndWait(task: vscode.Task): Promise<void> {
  return new Promise((resolve) => {
    vscode.tasks.executeTask(task).then((execution) => {
      const disposable = vscode.tasks.onDidEndTask(e => {
        if (e.execution === execution) {
          disposable.dispose();
          resolve();
        }
      });
    });
  });
}

export async function onirobuilderBuild(): Promise<void> {
  logChannel.appendLine(`[onirobuilder] onirobuilderBuild called`);
  await ensureSigningConfigs();

  // Fetch Oniro build task and execute it
  logChannel.appendLine(`[onirobuilder] Fetching Oniro build task...`);
  const allTasks = await vscode.tasks.fetchTasks({ type: 'oniro' });
  const buildTask = allTasks.find(t => t.name.includes('build'));

  if (!buildTask) {
    vscode.window.showErrorMessage('Could not find Oniro build task.');
    throw new Error('Missing Oniro build task');
  }

  try {
    logChannel.appendLine(`[onirobuilder] Running Build task...`);
    await runTaskAndWait(buildTask);
    logChannel.appendLine(`[onirobuilder] Build Process Complete.`);
  } catch (err) {
    logChannel.appendLine(`[onirobuilder] Error running Oniro build task: ${err}`);
    vscode.window.showErrorMessage(`Oniro build failed: ${err}`);
    throw err;
  }
}

export async function onirobuilderBuildWithParams(params: { product: string; module: string; buildMode: string }): Promise<void> {
  logChannel.appendLine(`[onirobuilder] onirobuilderBuildWithParams called`);
  await ensureSigningConfigs();

  const product = params.product?.trim();
  const moduleName = params.module?.trim();
  const buildMode = params.buildMode?.trim();

  if (!product || !moduleName || !buildMode) {
    vscode.window.showErrorMessage('Missing build parameters (product, module, build mode).');
    throw new Error('Missing build parameters');
  }

  const env = { ...process.env, OHOS_BASE_SDK_HOME: getOhosBaseSdkHome() };
  const hvigorwPath = getHvigorwPath(projectDir);
  const command = `${hvigorwPath} assembleHap --mode module -p product=${product} -p module=${moduleName} -p buildMode=${buildMode} --stacktrace --no-parallel --no-daemon`;
  const task = new vscode.Task(
    { type: 'oniro' },
    vscode.TaskScope.Workspace,
    'build (config)',
    'oniro',
    new vscode.ShellExecution(command, { cwd: projectDir, env }),
    []
  );

  try {
    logChannel.appendLine(`[onirobuilder] Running Build task with params: product=${product}, module=${moduleName}, buildMode=${buildMode}`);
    await runTaskAndWait(task);
    logChannel.appendLine(`[onirobuilder] Build Process Complete.`);
  } catch (err) {
    logChannel.appendLine(`[onirobuilder] Error running Oniro build task (params): ${err}`);
    vscode.window.showErrorMessage(`Oniro build failed: ${err}`);
    throw err;
  }
}

export async function onirobuilderSign(): Promise<void> {
  logChannel.appendLine(`[onirobuilder] onirobuilderSign called`);

  // Call the JS function directly instead of spawning a process
  try {
    logChannel.appendLine(`[onirobuilder] Generating signing configs using generateSigningConfigs...`);
    await new Promise<void>((resolve, reject) => {
      try {
        generateSigningConfigs(projectDir, getOhosBaseSdkHome());
        resolve();
      } catch (err) {
        logChannel.appendLine(`[onirobuilder] Error generating signing configs: ${err}`);
        reject(err);
      }
    });
    logChannel.appendLine(`[onirobuilder] Signing config generation complete.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to generate signing configs: ${err}`);
    throw err;
  }
}