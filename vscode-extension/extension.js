const vscode = require('vscode');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Virtual read-only document provider
// ---------------------------------------------------------------------------

const P17_OUTPUT_SCHEME = 'p17-output';

class P17ContentProvider {
    constructor() {
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChange = this._onDidChange.event;
        this._contents = new Map();
        this._languages = new Map();
    }

    set(uri, content, language) {
        this._contents.set(uri.toString(), content);
        this._languages.set(uri.toString(), language || 'plaintext');
        this._onDidChange.fire(uri);
    }

    getLanguage(uri) {
        return this._languages.get(uri.toString()) || 'plaintext';
    }

    provideTextDocumentContent(uri) {
        return this._contents.get(uri.toString()) || '';
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let statusBarItem;
let outputChannel;
let contentProvider;
let currentTarget = 'c';

const TARGET_LABELS = {
    'c': 'C17',
    'python': 'Python 3',
    'rust': 'Rust',
};

const TARGET_LANGUAGE_IDS = {
    'c': 'c',
    'python': 'python',
    'rust': 'rust',
};

function updateStatusBar() {
    if (statusBarItem) {
        const label = TARGET_LABELS[currentTarget] || currentTarget;
        statusBarItem.text = `$(symbol-class) P17 → ${label}`;
        statusBarItem.tooltip = `Target language: ${label}\nClick to change`;
        statusBarItem.show();
    }
}

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

function getEnginePath() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open. Open a Protocol 17 project first.');
    }
    const root = workspaceFolders[0].uri.fsPath;
    const enginePath = path.join(root, 'src', 'p17.py');
    if (!fs.existsSync(enginePath)) {
        throw new Error(
            `Protocol 17 engine not found at ${enginePath}. ` +
            'Make sure src/p17.py exists in your workspace.'
        );
    }
    return enginePath;
}

function getPythonCommand() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return 'python3';
    }
    const root = workspaceFolders[0].uri.fsPath;
    const venvPython = path.join(root, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) {
        return venvPython;
    }
    return 'python3';
}

// ---------------------------------------------------------------------------
// .p17.env parser — minimal, no shell evaluation
// ---------------------------------------------------------------------------

function parseEnvFile(content) {
    const result = {};
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        // Ignore blank lines and comments
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;

        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;

        const key = trimmed.substring(0, eqIdx).trim();
        let value = trimmed.substring(eqIdx + 1).trim();

        // Strip matching single/double quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        result[key] = value;
    }
    return result;
}

function runEngine(args, input) {
    return new Promise((resolve, reject) => {
        const enginePath = getEnginePath();
        const python = getPythonCommand();
        const allArgs = [enginePath, ...args];

        // ------------------------------------------------------------------
        // Build environment for the child process.
        // Base:  Extension Host process.env
        // Override: .p17.env values (workspace-explicit → takes precedence)
        // ------------------------------------------------------------------
        const env = { ...process.env };
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const dotEnvPath = path.join(workspaceFolders[0].uri.fsPath, '.p17.env');
            if (fs.existsSync(dotEnvPath)) {
                try {
                    const dotEnv = parseEnvFile(fs.readFileSync(dotEnvPath, 'utf-8'));
                    Object.assign(env, dotEnv);
                } catch (err) {
                    if (outputChannel) {
                        outputChannel.appendLine(
                            `Warning: failed to read .p17.env — ${err.message}`
                        );
                    }
                }
            }
        }

        // Verify API credentials are available after merging
        if (!env.P17_API_URL || !env.P17_API_KEY) {
            const msg = [
                'Environment variables P17_API_URL and P17_API_KEY must be set.',
                '',
                'To fix this:',
                '  1. Copy .p17.env.example to .p17.env in your workspace root',
                '  2. Edit .p17.env with your API credentials',
                '',
                'Or set P17_API_URL and P17_API_KEY in your shell environment.',
            ].join('\n');
            if (outputChannel) {
                outputChannel.appendLine(msg);
                outputChannel.show(true);
            }
            reject(new Error(msg));
            return;
        }

        const child = execFile(python, allArgs, {
            cwd: path.dirname(enginePath),
            timeout: 60000,
            maxBuffer: 10 * 1024 * 1024,
            env: env,
        }, (error, stdout, stderr) => {
            if (error && error.killed) {
                reject(new Error('Translation timed out (60s).'));
                return;
            }
            if (error && error.code !== 0 && !stdout) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve({ stdout: stdout || '', stderr: stderr || '', code: error ? error.code : 0 });
        });

        if (input) {
            child.stdin.write(input);
            child.stdin.end();
        }
    });
}

// ---------------------------------------------------------------------------
// Target verification — deterministic, no AI
// ---------------------------------------------------------------------------

function runVerification(sourcePath, target) {
    return new Promise((resolve) => {
        const enginePath = getEnginePath();
        const python = getPythonCommand();
        const allArgs = [enginePath, '--verify-file', sourcePath, '--target', target];

        const child = execFile(python, allArgs, {
            cwd: path.dirname(enginePath),
            timeout: 30000,
            maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error && error.killed) {
                resolve({ passed: false, diagnostics: 'Verification timed out (30s).' });
                return;
            }
            resolve({
                passed: error ? error.code === 0 : true,
                diagnostics: (stderr || stdout || '').trim(),
                code: error ? error.code : 0,
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function translateCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Protocol 17: No active editor.');
        return;
    }

    const document = editor.document;
    if (document.languageId !== 'p17') {
        vscode.window.showErrorMessage('Protocol 17: Active file is not a .p17 document.');
        return;
    }

    // NEVER save the source document.  Write current in-memory contents
    // (including unsaved edits) to a temporary file for the engine.
    const sourceText = document.getText();
    const sourcePath = document.uri.fsPath;
    const target = currentTarget;

    const enginePath = getEnginePath();
    const tmpDir = path.join(enginePath, '..', '..', 'build');
    const tmpFile = path.join(tmpDir, `.translate-tmp-${path.basename(sourcePath)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, sourceText);

    outputChannel.clear();
    outputChannel.appendLine(`Translating ${sourcePath} → ${TARGET_LABELS[target]}...`);

    try {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Protocol 17: Translating to ${TARGET_LABELS[target]}...`,
                cancellable: false,
            },
            async () => {
                return await runEngine([tmpFile, '--target', target, '--translate-only']);
            }
        );

        const output = result.stdout.trim();

        // Check for ambiguity
        if (output.startsWith('AMBIGUITY:') || output.startsWith('ambiguity:')) {
            outputChannel.appendLine('AMBIGUITY DETECTED:');
            outputChannel.appendLine(output);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Protocol 17: Ambiguity detected. See output channel.`);
            return;
        }

        // Show generated code in read-only virtual document beside the source
        const languageId = TARGET_LANGUAGE_IDS[target] || 'plaintext';
        const displayName = path.basename(sourcePath, '.p17');
        const ext = target === 'c' ? '.c' : target === 'python' ? '.py' : '.rs';
        const uri = vscode.Uri.parse(
            `${P17_OUTPUT_SCHEME}:${displayName}.generated${ext}?target=${target}`
        );
        contentProvider.set(uri, output, languageId);

        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: true,
        });

        outputChannel.appendLine('Translation complete.');

        // ------------------------------------------------------------------
        // Deterministic target verification (no AI)
        // ------------------------------------------------------------------
        const extMap = { 'c': '.c', 'python': '.py', 'rust': '.rs' };
        const verifyExt = extMap[target] || '.txt';
        const verifyTmp = path.join(tmpDir, `.verify-tmp-${displayName}${verifyExt}`);
        fs.writeFileSync(verifyTmp, output);

        try {
            const verifyResult = await runVerification(verifyTmp, target);

            if (verifyResult.passed) {
                outputChannel.appendLine(
                    `Protocol 17 verification: PASS (${TARGET_LABELS[target]})`
                );
            } else {
                outputChannel.appendLine(
                    `Protocol 17 verification: FAILED (${TARGET_LABELS[target]})`
                );
                if (verifyResult.diagnostics) {
                    outputChannel.appendLine('--- diagnostics ---');
                    outputChannel.appendLine(verifyResult.diagnostics);
                    outputChannel.appendLine('--- end diagnostics ---');
                }
                outputChannel.show(true);
                vscode.window.showWarningMessage(
                    `Protocol 17: ${TARGET_LABELS[target]} verification failed. See output channel.`
                );
            }
        } catch (verifyErr) {
            outputChannel.appendLine(
                `Protocol 17 verification: ERROR — ${verifyErr.message}`
            );
        } finally {
            try { fs.unlinkSync(verifyTmp); } catch (_) { /* ignore */ }
        }
    } catch (error) {
        outputChannel.appendLine(`ERROR: ${error.message}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`Protocol 17: Translation failed — ${error.message}`);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    }
}

async function selectTargetCommand() {
    const options = Object.entries(TARGET_LABELS).map(([value, label]) => ({
        label: label,
        description: value === 'c' ? '(compile & run available)' : '(translate only)',
        value: value,
    }));

    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select target language for translation',
        title: 'Protocol 17: Target Language',
    });

    if (selected) {
        currentTarget = selected.value;
        updateStatusBar();
        outputChannel.appendLine(`Target language set to: ${TARGET_LABELS[currentTarget]}`);
    }
}

async function explainCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Protocol 17: No active editor.');
        return;
    }

    const document = editor.document;

    // Use selected text if any, otherwise the whole document (in-memory,
    // never saving the source).  Write to a temp file for the engine.
    let sourceCode;
    let description;

    if (!editor.selection.isEmpty) {
        sourceCode = editor.document.getText(editor.selection);
        description = 'selected code';
    } else {
        sourceCode = editor.document.getText();
        description = path.basename(document.uri.fsPath);
    }

    outputChannel.appendLine(`Explaining ${description}...`);

    const enginePath = getEnginePath();
    const tmpDir = path.join(enginePath, '..', '..', 'build');
    const tmpFile = path.join(tmpDir, `.explain-tmp-${Date.now()}.txt`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, sourceCode);

    try {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Protocol 17: Explaining...',
                cancellable: false,
            },
            async () => {
                return await runEngine([tmpFile, '--reverse']);
            }
        );

        const explanation = result.stdout.trim();

        // Show in a markdown document
        const uri = vscode.Uri.parse(
            `${P17_OUTPUT_SCHEME}:explanation.md?t=${Date.now()}`
        );
        contentProvider.set(uri, explanation, 'markdown');

        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
        await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Beside,
        });

        outputChannel.appendLine('Explanation ready.');
    } catch (error) {
        outputChannel.appendLine(`ERROR: ${error.message}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`Protocol 17: Explain failed — ${error.message}`);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    }
}

async function runCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Protocol 17: No active editor.');
        return;
    }

    const document = editor.document;

    // Handle virtual P17 output documents (generated C code)
    if (document.uri.scheme === P17_OUTPUT_SCHEME) {
        const target = document.uri.query.match(/target=([^&]+)/);
        const lang = target ? target[1] : 'c';

        if (lang !== 'c') {
            vscode.window.showInformationMessage(
                `Protocol 17: Execution is not yet implemented for ${TARGET_LABELS[lang] || lang}. Only C17 compilation/execution is currently supported.`
            );
            return;
        }

        // Run generated C code via the engine's compile_and_run flow
        // Save the generated C to a temp file and run it
        const tmpDir = path.join(getEnginePath(), '..', '..', 'build');
        const tmpFile = path.join(tmpDir, 'run-tmp.c');
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(tmpFile, document.getText());

        try {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Protocol 17: Compiling & running...',
                    cancellable: false,
                },
                async () => {
                    return await runEngine([tmpFile, '--target', 'c']);
                }
            );
            outputChannel.clear();
            outputChannel.appendLine('=== Compile & Run Output ===');
            outputChannel.append(result.stdout);
            if (result.stderr) {
                outputChannel.appendLine('--- stderr ---');
                outputChannel.append(result.stderr);
            }
            outputChannel.show(true);
        } catch (error) {
            outputChannel.appendLine(`ERROR: ${error.message}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Protocol 17: Run failed — ${error.message}`);
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
        }
        return;
    }

    // Handle .p17 files: translate → compile → run (C only)
    if (document.languageId !== 'p17') {
        vscode.window.showErrorMessage('Protocol 17: Active file is not a .p17 document.');
        return;
    }

    if (currentTarget !== 'c') {
        vscode.window.showInformationMessage(
            `Protocol 17: Execution is not yet implemented for ${TARGET_LABELS[currentTarget]}. Only C17 compilation/execution is currently supported.`
        );
        return;
    }

    // NEVER save the source document.  Write current in-memory contents
    // to a temp file, then translate+compile+run via the engine.
    const sourceText = document.getText();
    const sourcePath = document.uri.fsPath;

    const enginePath = getEnginePath();
    const tmpDir = path.join(enginePath, '..', '..', 'build');
    const tmpFile = path.join(tmpDir, `.run-tmp-${path.basename(sourcePath)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, sourceText);

    outputChannel.clear();
    outputChannel.appendLine(`Running ${sourcePath}...`);

    try {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Protocol 17: Compiling & running...',
                cancellable: false,
            },
            async () => {
                return await runEngine([tmpFile]);
            }
        );

        outputChannel.appendLine('=== Compile & Run Output ===');
        outputChannel.append(result.stdout);
        if (result.stderr) {
            outputChannel.appendLine('--- stderr ---');
            outputChannel.append(result.stderr);
        }
        outputChannel.show(true);
    } catch (error) {
        outputChannel.appendLine(`ERROR: ${error.message}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`Protocol 17: Run failed — ${error.message}`);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// Activation / deactivation
// ---------------------------------------------------------------------------

function activate(context) {
    // Output channel
    outputChannel = vscode.window.createOutputChannel('Protocol 17');
    context.subscriptions.push(outputChannel);

    // Virtual document provider for read-only generated output
    contentProvider = new P17ContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            P17_OUTPUT_SCHEME, contentProvider
        )
    );

    // Status bar: target language
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusBarItem.command = 'protocol-17.selectTarget';
    updateStatusBar();
    context.subscriptions.push(statusBarItem);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('protocol-17.translate', translateCommand),
        vscode.commands.registerCommand('protocol-17.selectTarget', selectTargetCommand),
        vscode.commands.registerCommand('protocol-17.explain', explainCommand),
        vscode.commands.registerCommand('protocol-17.run', runCommand),
    );

    // Editor configuration for .p17 files
    vscode.languages.setLanguageConfiguration('p17', {
        tabSize: 4,
        insertSpaces: true,
    });

    outputChannel.appendLine('Protocol 17 extension activated.');
}

function deactivate() {
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}

module.exports = { activate, deactivate };
