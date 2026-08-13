const vscode = require('vscode');
const { execFile } = require('child_process');
const crypto = require('crypto');
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
        // Per-URI staleness: generated output that no longer corresponds to
        // the current .p17 source (translation in progress or failed).
        this._stale = new Map();
    }

    set(uri, content, language) {
        const key = uri.toString();
        this._contents.set(key, content);
        this._languages.set(key, language || 'plaintext');
        // Fresh generated code is current — clear any stale state.
        this._stale.delete(key);
        this._onDidChange.fire(uri);
    }

    /**
     * Mark previously generated output as stale so it can never look
     * current while a new translation runs or after a failure.
     *
     * Returns true when there was previous output to mark, false when this
     * source+target has no generated output yet (nothing can look stale).
     */
    markStale(uri, reason) {
        const key = uri.toString();
        if (!this._contents.has(key)) {
            return false;
        }
        this._stale.set(key, reason);
        this._onDidChange.fire(uri);
        return true;
    }

    getLanguage(uri) {
        return this._languages.get(uri.toString()) || 'plaintext';
    }

    provideTextDocumentContent(uri) {
        const key = uri.toString();
        const content = this._contents.get(key) || '';
        if (this._stale.has(key)) {
            // The banner is a comment in the target language, so the stale
            // code stays readable but is clearly marked as NOT current.
            const languageId = this._languages.get(key) || 'plaintext';
            return staleBanner(languageId, this._stale.get(key)) + '\n\n' + content;
        }
        return content;
    }
}

/**
 * Render a prominent stale marker as a comment in the target language.
 * Generated code must never appear current when it does not correspond to
 * the current .p17 source.
 */
function staleBanner(languageId, reason) {
    if (languageId === 'c') {
        return `/* STALE — ${reason} */`;
    }
    if (languageId === 'rust') {
        return `// STALE — ${reason}`;
    }
    return `# STALE — ${reason}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let statusBarItem;
let modelStatusBarItem;
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

// ---------------------------------------------------------------------------
// SecretStorage key — workspace-scoped to prevent cross-workspace key leaks.
//
// SecretStorage is global to the extension (not per-workspace), so we derive a
// stable, non-secret workspace identifier from the first workspace folder's
// URI path.  The raw path is never logged.
// ---------------------------------------------------------------------------

const SECRET_KEY_PREFIX = 'protocol17.apiKey';

/**
 * Return the workspace-scoped SecretStorage key for the current workspace.
 *
 * The key is derived from the first workspace folder's fsPath via a truncated
 * SHA-256 hash so that:
 *  - a key configured in workspace A never overrides .p17.env in workspace B
 *  - the raw workspace path is never placed in a log or persisted as-is
 *
 * If no workspace is open, falls back to a sentinel key that is NOT
 * workspace-scoped (single-file mode); this is inherently unscoped.
 */
function getWorkspaceSecretKey(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        // No workspace open — single-file mode.  There is nothing to scope
        // against, so fall back to the bare prefix.  This is harmless because
        // without a workspace there is no .p17.env to accidentally override.
        return SECRET_KEY_PREFIX;
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');
    // 16 hex chars (64 bits) is enough to avoid accidental collisions between
    // workspaces on the same machine.
    const shortHash = hash.substring(0, 16);
    return `${SECRET_KEY_PREFIX}.${shortHash}`;
}

// ---------------------------------------------------------------------------
// Workspace-state keys for non-secret configuration
// ---------------------------------------------------------------------------

const STATE_PROVIDER = 'protocol17.provider';
const STATE_MODEL = 'protocol17.model';
const STATE_API_URL = 'protocol17.apiUrl';
const STATE_TARGET = 'protocol17.target';

// ---------------------------------------------------------------------------
// Status bar helpers
// ---------------------------------------------------------------------------

function updateStatusBar() {
    if (statusBarItem) {
        const label = TARGET_LABELS[currentTarget] || currentTarget;
        statusBarItem.text = `$(symbol-class) P17 → ${label}`;
        statusBarItem.tooltip = `Target language: ${label}\nClick to change`;
        statusBarItem.show();
    }
}

function updateModelStatusBar(context) {
    if (!modelStatusBarItem) return;

    const provider = context.workspaceState.get(STATE_PROVIDER);
    const model = context.workspaceState.get(STATE_MODEL);

    if (provider && model) {
        modelStatusBarItem.text = `$(server) P17: ${model}`;
        modelStatusBarItem.tooltip = `Provider: ${provider}\nModel: ${model}\nClick to reconfigure`;
        modelStatusBarItem.command = 'protocol-17.configureModel';
    } else {
        modelStatusBarItem.text = `$(server) P17: Configure...`;
        modelStatusBarItem.tooltip = 'Configure AI model provider';
        modelStatusBarItem.command = 'protocol-17.configureModel';
    }
    modelStatusBarItem.show();
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
// Translation timeout — user-configurable via protocol17.translationTimeout
// ---------------------------------------------------------------------------

/**
 * Resolve the translation timeout in SECONDS.
 *
 * Defaults to 180 so long translations can complete.  0 means no timeout
 * (the engine runs until it finishes or fails).  Invalid or negative values
 * fall back to the default.
 */
function getTranslationTimeout() {
    const config = vscode.workspace.getConfiguration('protocol17');
    const value = config.get('translationTimeout', 180);
    // null / undefined mean "not configured" — use the default.  (Number(null)
    // would otherwise become 0, silently disabling the timeout.)
    if (value === null || value === undefined) {
        return 180;
    }
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
        return 180;
    }
    return seconds;
}

// ---------------------------------------------------------------------------
// Workspace .p17.env lookup — mirrors the engine's own search (src/p17.py
// find_env_file): start at the workspace and walk up parent directories.
// The extension deliberately does NOT parse the file itself anymore —
// the engine is the single source of truth for .p17.env resolution.
// ---------------------------------------------------------------------------

function findDotEnvFile() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return null; // No workspace — nothing to scope against
    }
    let dir = workspaceFolders[0].uri.fsPath;
    for (;;) {
        const candidate = path.join(dir, '.p17.env');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null; // Checked the filesystem root; nothing above it
        }
        dir = parent;
    }
}

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

/**
 * Build the effective environment for the engine child process.
 *
 * Precedence — matches the CLI's workspace semantics:
 *
 *   Workspace .p17.env exists  →  that file is the workspace model
 *       configuration source of truth.  Inherited P17_* variables are
 *       removed and VS Code stored configuration (workspaceState /
 *       SecretStorage) is NOT applied, so stale Configure Model values can
 *       never silently override the workspace file.  The engine loads the
 *       file itself (src/p17.py load_env_file), so parsing stays in one
 *       place and Translate / Test Model Connection / CLI all agree.
 *
 *   No .p17.env  →  VS Code configured model (workspaceState + workspace-
 *       scoped SecretStorage API key) over the Extension Host process
 *       environment.  This preserves SecretStorage for workspaces that
 *       configure the model through the extension UI.
 *
 * P17_API_KEY is never logged anywhere in this file.
 */
async function buildEngineEnv(context) {
    // Base: Extension Host process.env
    const env = { ...process.env };

    // ------------------------------------------------------------------
    // Workspace .p17.env — configuration source of truth
    // ------------------------------------------------------------------
    if (findDotEnvFile()) {
        // Remove inherited P17_* values so the engine's own loader applies
        // the workspace file (the engine prefers existing environment
        // variables, so they must be cleared first).
        for (const key of Object.keys(env)) {
            if (key.startsWith('P17_')) {
                delete env[key];
            }
        }
        return env; // engine resolves .p17.env itself
    }

    // ------------------------------------------------------------------
    // No workspace .p17.env — VS Code configured model + SecretStorage
    // ------------------------------------------------------------------
    const vsProvider = context.workspaceState.get(STATE_PROVIDER);
    const vsModel = context.workspaceState.get(STATE_MODEL);
    const vsApiUrl = context.workspaceState.get(STATE_API_URL);

    if (vsProvider) {
        env.P17_PROVIDER = vsProvider;
    }
    if (vsModel) {
        env.P17_MODEL = vsModel;
    }
    if (vsApiUrl) {
        env.P17_API_URL = vsApiUrl;
    }

    // The API key is workspace-scoped — a key from workspace A never
    // affects workspace B.
    try {
        const secretKey = await context.secrets.get(getWorkspaceSecretKey(context));
        if (secretKey) {
            env.P17_API_KEY = secretKey;
        }
    } catch (err) {
        if (outputChannel) {
            outputChannel.appendLine(
                `Warning: failed to read SecretStorage — ${err.message}`
            );
        }
    }

    return env;
}

// ---------------------------------------------------------------------------
// Engine execution
// ---------------------------------------------------------------------------

async function runEngine(context, args, input) {
    const enginePath = getEnginePath();
    const python = getPythonCommand();
    const allArgs = [enginePath, ...args];

    // Build effective environment with full precedence
    const env = await buildEngineEnv(context);

    // Verify API credentials are available after merging.  When the
    // workspace .p17.env exists, the engine resolves its own credentials
    // from that file, so there is nothing to pre-check here.
    if (!env.P17_API_KEY && !findDotEnvFile()) {
        const msg = [
            'Environment variable P17_API_KEY must be set.',
            '',
            'To fix this:',
            '  1. Copy .p17.env.example to .p17.env in your workspace root',
            '  2. Edit .p17.env with your API credentials',
            '  3. Set P17_PROVIDER if using a non-OpenAI-compatible provider',
            '',
            'Or run "Protocol 17: Configure Model" from the Command Palette.',
            '',
            'Supported providers: openai-compatible (default), anthropic, gemini.',
            'Or set P17_API_KEY in your shell environment.',
        ].join('\n');
        if (outputChannel) {
            outputChannel.appendLine(msg);
            outputChannel.show(true);
        }
        throw new Error(msg);
    }

    // User-configurable translation timeout.  timeoutMs of 0 tells
    // execFile to wait indefinitely (no timeout).
    const timeoutSeconds = getTranslationTimeout();
    const timeoutMs = timeoutSeconds * 1000;

    return new Promise((resolve, reject) => {
        const child = execFile(python, allArgs, {
            cwd: path.dirname(enginePath),
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: env,
        }, (error, stdout, stderr) => {
            if (error && error.killed) {
                reject(new Error(`Translation timed out (${timeoutSeconds}s).`));
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
// Command: Configure Model
// ---------------------------------------------------------------------------

async function configureModelCommand(context) {
    // Step 1: Select provider
    const providerOptions = [
        {
            label: 'OpenAI-compatible',
            description: 'OpenAI, Ollama, DeepSeek, OpenRouter, etc.',
            value: 'openai-compatible',
        },
        {
            label: 'Anthropic',
            description: 'Claude models via Anthropic API',
            value: 'anthropic',
        },
        {
            label: 'Gemini',
            description: 'Google Gemini models',
            value: 'gemini',
        },
    ];

    const selectedProvider = await vscode.window.showQuickPick(providerOptions, {
        placeHolder: 'Select AI provider',
        title: 'Protocol 17: Configure Model — Provider',
    });

    if (!selectedProvider) return; // User cancelled

    // Step 2: Ask for model name
    const currentModel = context.workspaceState.get(STATE_MODEL, '');
    const modelName = await vscode.window.showInputBox({
        prompt: 'Enter model name or ID',
        placeHolder: selectedProvider.value === 'openai-compatible'
            ? 'gpt-4o'
            : selectedProvider.value === 'anthropic'
                ? 'claude-sonnet-5-20251001'
                : 'gemini-2.5-flash',
        value: currentModel,
        title: 'Protocol 17: Configure Model — Model',
        validateInput: (value) => {
            if (!value || !value.trim()) {
                return 'Model name is required.';
            }
            return null;
        },
    });

    if (modelName === undefined) return; // User cancelled

    // Step 3: For openai-compatible only, ask for API URL
    let apiUrl = '';
    if (selectedProvider.value === 'openai-compatible') {
        const currentUrl = context.workspaceState.get(STATE_API_URL, '');
        apiUrl = await vscode.window.showInputBox({
            prompt: 'Enter API base URL',
            placeHolder: 'https://api.openai.com/v1',
            value: currentUrl,
            title: 'Protocol 17: Configure Model — API URL',
            validateInput: (value) => {
                if (!value || !value.trim()) {
                    return 'API URL is required for OpenAI-compatible providers.';
                }
                return null;
            },
        });

        if (apiUrl === undefined) return; // User cancelled
    }

    // Step 4: Ask for API key (password-masked)
    const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter API key (stored securely with VS Code SecretStorage)',
        placeHolder: selectedProvider.value === 'openai-compatible'
            ? 'sk-... or ollama'
            : selectedProvider.value === 'anthropic'
                ? 'sk-ant-...'
                : 'Your Gemini API key',
        password: true, // Mask the input
        title: 'Protocol 17: Configure Model — API Key',
        validateInput: (value) => {
            if (!value || !value.trim()) {
                return 'API key is required.';
            }
            return null;
        },
    });

    if (apiKey === undefined) return; // User cancelled

    // Step 5: Store non-secret config in workspaceState
    await context.workspaceState.update(STATE_PROVIDER, selectedProvider.value);
    await context.workspaceState.update(STATE_MODEL, modelName.trim());
    if (selectedProvider.value === 'openai-compatible') {
        await context.workspaceState.update(STATE_API_URL, apiUrl.trim());
    } else {
        // Clear API URL for providers that don't need it
        await context.workspaceState.update(STATE_API_URL, undefined);
    }

    // Step 6: Store API key in SecretStorage (never in settings or env files)
    // NOTE: Do not log the key anywhere.  The key is workspace-scoped so a
    // key from this workspace never affects another workspace.
    await context.secrets.store(getWorkspaceSecretKey(context), apiKey);

    // Update status bar
    updateModelStatusBar(context);

    // Report success (never show the key)
    const providerLabel = selectedProvider.label;
    outputChannel.appendLine(
        `Model configured: ${providerLabel} / ${modelName.trim()} (API key stored in SecretStorage)`
    );
    vscode.window.showInformationMessage(
        `Protocol 17: Model configured — ${providerLabel} / ${modelName.trim()}`
    );

    // When the workspace has a .p17.env file, that file takes precedence
    // over everything stored above.  Surface this so the user understands
    // why a just-configured model is not the one being used.
    if (findDotEnvFile()) {
        outputChannel.appendLine(
            'Note: this workspace has a .p17.env file, which is the model ' +
            'configuration source of truth and takes precedence over the ' +
            'configuration just stored. Remove the file to use these values.'
        );
        vscode.window.showWarningMessage(
            'Protocol 17: Workspace .p17.env takes precedence over this configuration.'
        );
    }

    // Offer to test connection
    const testChoice = await vscode.window.showInformationMessage(
        'Would you like to test the connection?',
        { modal: false },
        'Test Connection',
    );

    if (testChoice === 'Test Connection') {
        await testConnectionCommand(context);
    }
}

// ---------------------------------------------------------------------------
// Command: Test Model Connection
// ---------------------------------------------------------------------------

async function testConnectionCommand(context) {
    const provider = context.workspaceState.get(STATE_PROVIDER) || 'openai-compatible';
    const model = context.workspaceState.get(STATE_MODEL) || '(not configured)';

    // Build the effective environment to pass to --test-provider
    const enginePath = getEnginePath();
    const python = getPythonCommand();

    let env;
    try {
        env = await buildEngineEnv(context);
    } catch (err) {
        outputChannel.appendLine(`Connection test failed: ${err.message}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(
            `Protocol 17: Model connection failed\nConfiguration error — see Output Channel.`
        );
        return;
    }

    outputChannel.appendLine(`Testing connection: ${provider} / ${model}...`);

    try {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Protocol 17: Testing ${provider} / ${model}...`,
                cancellable: false,
            },
            async () => {
                return await new Promise((resolve, reject) => {
                    const child = execFile(python, [enginePath, '--test-provider'], {
                        cwd: path.dirname(enginePath),
                        timeout: 30000,
                        maxBuffer: 1024 * 1024,
                        env: env,
                    }, (error, stdout, stderr) => {
                        if (error && error.killed) {
                            reject(new Error('Connection test timed out (30s).'));
                            return;
                        }
                        resolve({
                            stdout: stdout || '',
                            stderr: stderr || '',
                            code: error ? error.code : 0,
                        });
                    });
                });
            }
        );

        if (result.code === 0) {
            const successMsg = `Protocol 17: Model connection successful (${provider} / ${model})`;
            outputChannel.appendLine(successMsg);
            // The P17_OK line from --test-provider goes to stderr, append it
            if (result.stderr.trim()) {
                outputChannel.appendLine(result.stderr.trim());
            }
            vscode.window.showInformationMessage(successMsg);
        } else {
            const failMsg = `Protocol 17: Model connection failed`;
            outputChannel.appendLine(failMsg);
            // Include safe diagnostic (never contains API key — redaction is done in Python)
            if (result.stderr.trim()) {
                outputChannel.appendLine(`Diagnostic: ${result.stderr.trim()}`);
            }
            outputChannel.show(true);
            vscode.window.showErrorMessage(
                `${failMsg}\n${result.stderr.trim() || 'See Output Channel for details.'}`
            );
        }
    } catch (err) {
        outputChannel.appendLine(`Connection test error: ${err.message}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(
            `Protocol 17: Model connection failed\nSee Output Channel for details.`
        );
    }
}

// ---------------------------------------------------------------------------
// Command: Translate
// ---------------------------------------------------------------------------

async function translateCommand(context) {
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

    // The generated-output document URI is stable for a given source file +
    // target, so repeated translates refresh the same editor instead of
    // piling up tabs.  (A short hash of the source path keeps same-named
    // files apart.)  It is computed BEFORE translating so any previous
    // output can be marked stale while the new translation runs.
    const displayName = path.basename(sourcePath, '.p17');
    const sourceHash = crypto.createHash('sha256').update(sourcePath).digest('hex').substring(0, 8);
    const ext = target === 'c' ? '.c' : target === 'python' ? '.py' : '.rs';
    const uri = vscode.Uri.parse(
        `${P17_OUTPUT_SCHEME}:${displayName}-${sourceHash}.generated${ext}?target=${target}`
    );

    // Mark any previous generated output for this source+target as stale:
    // generated code must never appear current while a new translation is
    // running.  The stale state is cleared only by a successful translation
    // (contentProvider.set below).
    contentProvider.markStale(
        uri,
        'A new translation is in progress. This output no longer corresponds to the current Protocol 17 source.'
    );

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
                return await runEngine(context, [tmpFile, '--target', target, '--translate-only']);
            }
        );

        const output = result.stdout.trim();

        // Check for ambiguity
        if (output.startsWith('AMBIGUITY:') || output.startsWith('ambiguity:')) {
            // No code was generated — previous output stays visibly stale.
            contentProvider.markStale(
                uri,
                'Translation failed: ambiguity detected. Previous generated output is stale and may not correspond to the current Protocol 17 source.'
            );
            outputChannel.appendLine('AMBIGUITY DETECTED:');
            outputChannel.appendLine(output);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Protocol 17: Ambiguity detected. See output channel.`);
            return;
        }

        // Show generated code in read-only virtual document beside the
        // source.  set() clears the stale state — the new code is current.
        const languageId = TARGET_LANGUAGE_IDS[target] || 'plaintext';
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
        // The previous generated output must never look current after a
        // failure or timeout — keep it visibly marked as stale.
        contentProvider.markStale(
            uri,
            'Translation failed. Previous generated output is stale and may not correspond to the current Protocol 17 source.'
        );
        outputChannel.appendLine(`ERROR: ${error.message}`);
        outputChannel.appendLine(
            'Previous generated output is stale and may not correspond to the current Protocol 17 source.'
        );
        outputChannel.show(true);
        vscode.window.showErrorMessage(
            `Protocol 17: Translation failed — ${error.message}\n` +
            'Previous generated output is stale and may not correspond to the current Protocol 17 source.'
        );
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// Command: Select Target
// ---------------------------------------------------------------------------

async function selectTargetCommand(context) {
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
        // Persist per workspace so the choice survives reload / reopen.
        // The .p17 source document is never modified.
        await context.workspaceState.update(STATE_TARGET, selected.value);
        updateStatusBar();
        outputChannel.appendLine(`Target language set to: ${TARGET_LABELS[currentTarget]}`);
    }
}

// ---------------------------------------------------------------------------
// Command: Explain
// ---------------------------------------------------------------------------

async function explainCommand(context) {
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
                return await runEngine(context, [tmpFile, '--reverse']);
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

// ---------------------------------------------------------------------------
// Command: Run
// ---------------------------------------------------------------------------

async function runCommand(context) {
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
                    return await runEngine(context, [tmpFile, '--target', 'c']);
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
                return await runEngine(context, [tmpFile]);
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

    // Restore the persisted target language (workspace-scoped).  Defaults to
    // C17 when nothing was saved yet or the saved value is no longer known.
    const savedTarget = context.workspaceState.get(STATE_TARGET);
    currentTarget = Object.prototype.hasOwnProperty.call(TARGET_LABELS, savedTarget)
        ? savedTarget
        : 'c';

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

    // Status bar: model configuration
    modelStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 99
    );
    updateModelStatusBar(context);
    context.subscriptions.push(modelStatusBarItem);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('protocol-17.translate', () => translateCommand(context)),
        vscode.commands.registerCommand('protocol-17.selectTarget', () => selectTargetCommand(context)),
        vscode.commands.registerCommand('protocol-17.explain', () => explainCommand(context)),
        vscode.commands.registerCommand('protocol-17.run', () => runCommand(context)),
        vscode.commands.registerCommand('protocol-17.configureModel', () => configureModelCommand(context)),
        vscode.commands.registerCommand('protocol-17.testConnection', () => testConnectionCommand(context)),
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
    if (modelStatusBarItem) {
        modelStatusBarItem.dispose();
    }
}

module.exports = { activate, deactivate };
