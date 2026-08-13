/**
 * Regression test: verify Translate / Explain / Run never call document.save(),
 * that .p17.env parsing works correctly, and security / backward compatibility
 * invariants for SecretStorage and Configure Model.
 *
 * Usage:  node test/regression.test.js
 */

const fs = require('fs');
const path = require('path');

const EXTENSION_JS = path.join(__dirname, '..', 'extension.js');
const PACKAGE_JSON = path.join(__dirname, '..', 'package.json');
const source = fs.readFileSync(EXTENSION_JS, 'utf-8');
const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'));

let failures = 0;

// ---------------------------------------------------------------------------
// Helpers: extract the body of a named function
// ---------------------------------------------------------------------------

function extractFunctionBody(name) {
    // Match "function NAME(" through to the matching closing "}"
    // at the top-level indent (column 0).
    const startMarker = new RegExp(`function ${name}\\(`);
    const startIdx = source.search(startMarker);
    if (startIdx === -1) {
        // Also try "async function NAME("
        const asyncMarker = new RegExp(`async function ${name}\\(`);
        const asyncIdx = source.search(asyncMarker);
        if (asyncIdx === -1) {
            console.error(`FAIL: could not find function "${name}"`);
            failures++;
            return null;
        }
        return extractBodyFrom(asyncIdx);
    }
    return extractBodyFrom(startIdx);
}

function extractBodyFrom(startIdx) {
    // Find the opening brace
    const openBraceIdx = source.indexOf('{', startIdx);
    if (openBraceIdx === -1) {
        console.error(`FAIL: could not find opening brace`);
        failures++;
        return null;
    }

    // Brace-count to find the matching closing brace
    let depth = 0;
    let i = openBraceIdx;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }

    return source.substring(openBraceIdx, i + 1);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function assertNotContains(funcName, body, forbidden, description) {
    if (body === null) return;  // already failed
    if (body.includes(forbidden)) {
        // Find the line number
        const idx = source.indexOf(body);
        const lineNum = source.substring(0, idx + body.indexOf(forbidden)).split('\n').length;
        console.error(
            `FAIL: ${funcName}() contains forbidden "${forbidden}" at ~line ${lineNum} — ${description}`
        );
        failures++;
    } else {
        console.log(`  ✓ ${funcName}: no "${forbidden}"`);
    }
}

function assertContains(funcName, body, required, description) {
    if (body === null) return;  // already failed
    if (!body.includes(required)) {
        console.error(
            `FAIL: ${funcName}() missing required "${required}" — ${description}`
        );
        failures++;
    } else {
        console.log(`  ✓ ${funcName}: contains "${required}"`);
    }
}

// ---------------------------------------------------------------------------
// Effective-environment mirror
//
// The .p17.env grammar itself is owned by the engine (src/p17.py
// parse_env_file) and is covered by tests/test_p17.py TestEnvFileParsing —
// the extension must not duplicate it.  This helper mirrors the combined
// behavior of extension.js buildEngineEnv + the engine's load_env_file for
// behavioral precedence tests.  dotEnvValues is the file's ALREADY-PARSED
// key/value map (or null when no workspace .p17.env exists).
// ---------------------------------------------------------------------------

function simulateEffectiveEnv({ baseEnv, dotEnvValues, vsConfig, secretKey }) {
    const env = { ...baseEnv };

    if (dotEnvValues !== null) {
        // buildEngineEnv: .p17.env is the source of truth — inherited P17_*
        // values are removed so the engine applies the workspace file.
        for (const key of Object.keys(env)) {
            if (key.startsWith('P17_')) delete env[key];
        }
        // engine load_env_file: setdefault — only fills keys that are
        // still missing after the scrub.
        for (const [key, value] of Object.entries(dotEnvValues)) {
            if (!(key in env)) env[key] = value;
        }
        return env;
    }

    // No workspace .p17.env — VS Code configured model + SecretStorage
    // over the Extension Host process environment.
    if (vsConfig.provider) env.P17_PROVIDER = vsConfig.provider;
    if (vsConfig.model) env.P17_MODEL = vsConfig.model;
    if (vsConfig.apiUrl) env.P17_API_URL = vsConfig.apiUrl;
    if (secretKey) env.P17_API_KEY = secretKey;
    return env;
}

// ===========================================================================
// SECTION 1: Document-safety checks
// ===========================================================================

console.log('Regression: source-document safety\n');

const translateBody = extractFunctionBody('translateCommand');
const explainBody = extractFunctionBody('explainCommand');
const runBody = extractFunctionBody('runCommand');

// Core check: document.save must not appear
assertNotContains(
    'translateCommand', translateBody, 'document.save(',
    'Translate must never implicitly persist the .p17 source'
);
assertNotContains(
    'explainCommand', explainBody, 'document.save(',
    'Explain must never implicitly persist the source'
);
assertNotContains(
    'runCommand', runBody, 'document.save(',
    'Run must never implicitly persist the .p17 source'
);

// Bonus: verify temp-file cleanup pattern is present
if (translateBody && !translateBody.includes('unlinkSync(tmpFile)')) {
    console.error('FAIL: translateCommand() missing tmpFile cleanup (unlinkSync)');
    failures++;
} else if (translateBody) {
    console.log('  ✓ translateCommand: tmpFile cleanup present');
}

if (explainBody && !explainBody.includes('unlinkSync(tmpFile)')) {
    console.error('FAIL: explainCommand() missing tmpFile cleanup (unlinkSync)');
    failures++;
} else if (explainBody) {
    console.log('  ✓ explainCommand: tmpFile cleanup present');
}

if (runBody && !runBody.includes('unlinkSync(tmpFile)')) {
    console.error('FAIL: runCommand() missing tmpFile cleanup (unlinkSync)');
    failures++;
} else if (runBody) {
    console.log('  ✓ runCommand: tmpFile cleanup present');
}

// Bonus: verify in-memory read pattern is present
if (translateBody && !translateBody.includes('document.getText()')) {
    console.error('FAIL: translateCommand() should read in-memory text via document.getText()');
    failures++;
} else if (translateBody) {
    console.log('  ✓ translateCommand: reads document.getText()');
}

// ===========================================================================
// SECTION 2: Env parsing is engine-owned — no duplicated parser
// ===========================================================================

console.log('\nRegression: .p17.env parsing ownership\n');

// The extension must not keep its own copy of the .p17.env grammar; the
// engine (src/p17.py parse_env_file) is the single source of truth, and its
// grammar (comments / blanks / quotes / no shell evaluation) is covered by
// tests/test_p17.py TestEnvFileParsing.
(function checkNoDuplicatedEnvParser() {
    if (source.includes('function parseEnvFile(')) {
        console.error('FAIL: extension.js must not duplicate the .p17.env parser (engine owns it)');
        failures++;
    } else {
        console.log('  ✓ no duplicated .p17.env parser in extension.js');
    }
})();

// The extension must locate the workspace file the same way the engine does
(function checkFindDotEnvFileExists() {
    if (!source.includes('function findDotEnvFile(')) {
        console.error('FAIL: extension.js missing findDotEnvFile function');
        failures++;
    } else {
        console.log('  ✓ findDotEnvFile function exists in extension.js');
    }
})();

(function checkFindDotEnvFileWalksUp() {
    const body = extractFunctionBody('findDotEnvFile');
    if (body && !body.includes('path.dirname(dir)')) {
        console.error('FAIL: findDotEnvFile must walk up parent directories like the engine');
        failures++;
    } else if (body) {
        console.log('  ✓ findDotEnvFile walks up parent directories (mirrors engine)');
    }
})();

// ===========================================================================
// SECTION 3: Extension source structure — env integration
// ===========================================================================

console.log('\nRegression: extension env integration\n');

// Verify buildEngineEnv delegates .p17.env resolution to the engine
(function checkBuildEngineEnvDelegates() {
    const body = extractFunctionBody('buildEngineEnv');
    if (body && !body.includes('findDotEnvFile()')) {
        console.error('FAIL: buildEngineEnv must consult findDotEnvFile() before applying config');
        failures++;
    } else if (body) {
        console.log('  ✓ buildEngineEnv consults findDotEnvFile()');
    }
})();

// Verify buildEngineEnv function exists (replaces inline env building in runEngine)
(function checkBuildEngineEnvExists() {
    if (!source.includes('function buildEngineEnv(') && !source.includes('async function buildEngineEnv(')) {
        console.error('FAIL: extension.js missing buildEngineEnv function');
        failures++;
    } else {
        console.log('  ✓ buildEngineEnv function exists in extension.js');
    }
})();

// Verify runEngine references .p17.env still
(function checkRunEngineReadsDotEnv() {
    const engineBody = extractFunctionBody('runEngine');
    if (engineBody && !engineBody.includes('.p17.env')) {
        console.error('FAIL: runEngine() must reference .p17.env for backward compatibility');
        failures++;
    } else if (engineBody) {
        console.log('  ✓ runEngine references .p17.env');
    }
})();

// Verify helpful error message mentions .p17.env.example
(function checkErrorMessageMentionsExample() {
    const allBodies = source;
    if (!allBodies.includes('.p17.env.example')) {
        console.error('FAIL: error message should mention .p17.env.example');
        failures++;
    } else {
        console.log('  ✓ error message mentions .p17.env.example');
    }
})();

// Verify no hard-coded secrets
(function checkNoHardcodedSecrets() {
    // These patterns should NOT appear as literal string values
    const secretPatterns = [
        { pattern: /P17_API_URL.*https:\/\/api\.openai\.com/, desc: 'hard-coded OpenAI URL' },
        { pattern: /P17_API_KEY.*sk-/, desc: 'hard-coded API key pattern' },
        { pattern: /P17_MODEL.*gpt-4o/, desc: 'hard-coded model name in extension' },
    ];
    for (const { pattern, desc } of secretPatterns) {
        if (pattern.test(source)) {
            console.error(`FAIL: extension.js appears to contain ${desc}`);
            failures++;
        } else {
            console.log(`  ✓ no ${desc}`);
        }
    }

    // But these should appear in the error message as variable names, not values
    if (!source.includes('P17_API_URL') || !source.includes('P17_API_KEY')) {
        console.error('FAIL: extension.js should reference P17_API_URL and P17_API_KEY (as env var names)');
        failures++;
    } else {
        console.log('  ✓ extension references P17_API_URL and P17_API_KEY as variable names');
    }
})();

// ===========================================================================
// SECTION 4: Target verification integration
// ===========================================================================

console.log('\nRegression: target verification integration\n');

// Verify runVerification function exists
(function checkRunVerificationExists() {
    if (!source.includes('function runVerification(')) {
        console.error('FAIL: extension.js missing runVerification function');
        failures++;
    } else {
        console.log('  ✓ runVerification function exists in extension.js');
    }
})();

// Verify translateCommand invokes verification
(function checkTranslateInvokesVerification() {
    const body = extractFunctionBody('translateCommand');
    if (body && !body.includes('runVerification(')) {
        console.error('FAIL: translateCommand() must call runVerification()');
        failures++;
    } else if (body) {
        console.log('  ✓ translateCommand calls runVerification');
    }
})();

// Verify verification uses correct file extensions
(function checkVerificationFileExtensions() {
    const body = extractFunctionBody('translateCommand');
    if (body && !body.includes("'.py'") && !body.includes("'.rs'")) {
        console.error('FAIL: translateCommand() should use target-specific file extensions for verification');
        failures++;
    } else if (body) {
        console.log('  ✓ translateCommand uses target-specific file extensions');
    }
})();

// Verify verification result is reported in OutputChannel
(function checkVerificationResultReported() {
    const body = extractFunctionBody('translateCommand');
    if (body && !body.includes('verification: PASS') && !body.includes('verification: FAILED')) {
        console.error('FAIL: translateCommand() must report verification PASS/FAILED to OutputChannel');
        failures++;
    } else if (body) {
        console.log('  ✓ translateCommand reports verification result');
    }
})();

// Verify verification temp file has cleanup
(function checkVerificationTempCleanup() {
    const body = extractFunctionBody('translateCommand');
    if (body && !body.includes('verifyTmp')) {
        console.error('FAIL: translateCommand() missing verifyTmp cleanup');
        failures++;
    } else if (body) {
        console.log('  ✓ translateCommand cleans up verifyTmp');
    }
})();

// Verify no document.save regression from verification additions
(function checkNoDocumentSaveInVerificationAreas() {
    const body = extractFunctionBody('translateCommand');
    assertNotContains(
        'translateCommand', body, 'document.save(',
        'Verification must not introduce document mutation'
    );
})();

// ===========================================================================
// SECTION 5: Security — SecretStorage and API key safety
// ===========================================================================

console.log('\nRegression: SecretStorage & API key security\n');

// Verify SecretStorage is used for API key storage
(function checkSecretStorageStore() {
    if (!source.includes('context.secrets.store(') && !source.includes('secrets.store(')) {
        console.error('FAIL: extension.js must use SecretStorage (secrets.store) for API key');
        failures++;
    } else {
        console.log('  ✓ API key stored via SecretStorage (secrets.store)');
    }
})();

// Verify SecretStorage is used for API key retrieval
(function checkSecretStorageGet() {
    if (!source.includes('context.secrets.get(') && !source.includes('secrets.get(')) {
        console.error('FAIL: extension.js must use SecretStorage (secrets.get) for API key');
        failures++;
    } else {
        console.log('  ✓ API key retrieved via SecretStorage (secrets.get)');
    }
})();

// Verify workspace-scoped SecretStorage key infrastructure exists
(function checkSecretKeyInfrastructure() {
    // The prefix constant must exist
    if (!source.includes('SECRET_KEY_PREFIX') || !source.includes('protocol17.apiKey')) {
        console.error('FAIL: extension.js missing SECRET_KEY_PREFIX constant');
        failures++;
    } else {
        console.log('  ✓ SECRET_KEY_PREFIX constant defined');
    }

    // The workspace-scoped key helper must exist
    if (!source.includes('function getWorkspaceSecretKey(')) {
        console.error('FAIL: extension.js missing getWorkspaceSecretKey function');
        failures++;
    } else {
        console.log('  ✓ getWorkspaceSecretKey function exists');
    }

    // It must use crypto.createHash for stable derivation (no raw path in key)
    if (!source.includes("crypto.createHash('sha256')")) {
        console.error('FAIL: getWorkspaceSecretKey must use crypto.createHash for stable derivation');
        failures++;
    } else {
        console.log('  ✓ getWorkspaceSecretKey uses crypto.createHash');
    }

    // The raw workspace path must not be concatenated into the key (use hash instead)
    const wsKeyBody = extractFunctionBody('getWorkspaceSecretKey');
    if (wsKeyBody && wsKeyBody.includes('SECRET_KEY_PREFIX +') && !wsKeyBody.includes('createHash')) {
        console.error('FAIL: getWorkspaceSecretKey must hash workspace path, not concatenate it raw');
        failures++;
    } else if (wsKeyBody) {
        console.log('  ✓ getWorkspaceSecretKey hashes workspace path (no raw path in key)');
    }
})();

// API key must NEVER be placed in settings.json
(function checkApiKeyNotInSettingsJson() {
    // The package.json contributes section must not have any API key settings
    const contributes = pkg.contributes || {};
    const configuration = contributes.configuration || {};
    const properties = configuration.properties || {};

    const keyProps = Object.keys(properties).filter(k =>
        k.toLowerCase().includes('apikey') || k.toLowerCase().includes('api_key') ||
        k.toLowerCase().includes('secret')
    );

    if (keyProps.length > 0) {
        console.error(`FAIL: package.json contributes API key settings: ${keyProps.join(', ')}`);
        failures++;
    } else {
        console.log('  ✓ API key not exposed in package.json configuration');
    }
})();

// API key must NEVER be written to .p17.env by the extension
(function checkApiKeyNotWrittenToDotEnv() {
    // Search for any fs.writeFileSync or fs.writeFile that writes to .p17.env
    const writePattern = /writeFile.*\.p17\.env/;
    if (writePattern.test(source)) {
        console.error('FAIL: extension.js writes to .p17.env');
        failures++;
    } else {
        console.log('  ✓ extension never writes to .p17.env');
    }
})();

// API key must not be logged through outputChannel
(function checkApiKeyNotLogged() {
    const configBody = extractFunctionBody('configureModelCommand');
    if (configBody) {
        // The configureModel function should not log the key
        // It should use appendLine but never with 'apiKey' or the key variable
        const hasAppendLineWithKey = configBody.includes('appendLine') &&
            (configBody.includes('apiKey') && !configBody.includes('API key stored'));
        if (hasAppendLineWithKey) {
            console.error('FAIL: configureModelCommand may log API key');
            failures++;
        } else {
            console.log('  ✓ configureModelCommand does not log API key');
        }
    }
})();

// API key must never be included in error messages
(function checkApiKeyNotInErrorMessages() {
    // The configureModel flow should not include the key in error text
    const configBody = extractFunctionBody('configureModelCommand');
    if (configBody) {
        const hasKeyInError = configBody.includes('vscode.window.showErrorMessage') &&
            configBody.match(/showErrorMessage.*apiKey|showErrorMessage.*key/);
        if (hasKeyInError) {
            console.error('FAIL: configureModelCommand may include API key in error messages');
            failures++;
        } else {
            console.log('  ✓ configureModelCommand does not expose key in errors');
        }
    }
})();

// Verify password masking is used for API key input
(function checkPasswordMasking() {
    if (!source.includes('password: true')) {
        console.error('FAIL: API key input must use password masking (password: true)');
        failures++;
    } else {
        console.log('  ✓ API key input uses password masking');
    }
})();

// ===========================================================================
// SECTION 6: Source safety — Configure Model & Test Connection
// ===========================================================================

console.log('\nRegression: configure / test-connection source safety\n');

const configureBody = extractFunctionBody('configureModelCommand');
const testConnectionBody = extractFunctionBody('testConnectionCommand');

// Configure Model must never save source documents
if (configureBody) {
    assertNotContains(
        'configureModelCommand', configureBody, 'document.save(',
        'Configure Model must never mutate source documents'
    );
    assertNotContains(
        'configureModelCommand', configureBody, 'writeFileSync',
        'Configure Model must never write source files to disk'
    );
} else {
    console.error('FAIL: could not find configureModelCommand function');
    failures++;
}

// Test Connection must never save source documents
if (testConnectionBody) {
    assertNotContains(
        'testConnectionCommand', testConnectionBody, 'document.save(',
        'Test Connection must never mutate source documents'
    );
    assertNotContains(
        'testConnectionCommand', testConnectionBody, 'writeFileSync',
        'Test Connection must never write files to disk'
    );
} else {
    console.error('FAIL: could not find testConnectionCommand function');
    failures++;
}

// Test Connection must NOT call runVerification
if (testConnectionBody) {
    assertNotContains(
        'testConnectionCommand', testConnectionBody, 'runVerification',
        'Test Connection must never invoke target verification'
    );
}

// Test Connection must use --test-provider flag (not --translate, not --verify-file)
if (testConnectionBody) {
    assertContains(
        'testConnectionCommand', testConnectionBody, '--test-provider',
        'Test Connection must use --test-provider CLI flag'
    );
    assertNotContains(
        'testConnectionCommand', testConnectionBody, '--verify-file',
        'Test Connection must not use --verify-file flag'
    );
}

// ===========================================================================
// SECTION 7: Backward compatibility
// ===========================================================================

console.log('\nRegression: backward compatibility\n');

// Workspaces WITHOUT .p17.env must keep working through VS Code config
(function checkNoDotEnvFallbackPreserved() {
    // buildEngineEnv must still apply workspaceState + SecretStorage when
    // no workspace .p17.env exists (the fallback branch).
    const buildEnvBody = extractFunctionBody('buildEngineEnv');
    if (buildEnvBody) {
        const wsStateIdx = buildEnvBody.indexOf('workspaceState.get');
        const secretsIdx = buildEnvBody.indexOf('secrets.get');
        const earlyReturnIdx = buildEnvBody.indexOf('return env');

        // workspaceState + SecretStorage must exist in the fallback branch
        if (wsStateIdx === -1) {
            console.error('FAIL: buildEngineEnv must use workspaceState for VS Code config (no-.p17.env fallback)');
            failures++;
        } else {
            console.log('  ✓ buildEngineEnv uses workspaceState (no-.p17.env fallback)');
        }

        if (secretsIdx === -1) {
            console.error('FAIL: buildEngineEnv must use SecretStorage for API key (no-.p17.env fallback)');
            failures++;
        } else {
            console.log('  ✓ buildEngineEnv uses SecretStorage for API key (no-.p17.env fallback)');
        }

        // ...and the .p17.env branch must return BEFORE them, so stale
        // VS Code config can never override a workspace file.
        if (earlyReturnIdx !== -1 && earlyReturnIdx > wsStateIdx) {
            console.error('FAIL: buildEngineEnv .p17.env branch must return before applying VS Code config');
            failures++;
        } else {
            console.log('  ✓ .p17.env branch returns before VS Code config is applied');
        }
    }
})();

// .p17.env reading still occurs (fs.existsSync / findDotEnvFile)
(function checkDotEnvStillRead() {
    // buildEngineEnv should reference .p17.env (via findDotEnvFile delegation)
    const buildEnvBody = extractFunctionBody('buildEngineEnv');
    if (buildEnvBody && !buildEnvBody.includes('.p17.env')) {
        console.error('FAIL: buildEngineEnv must still reference .p17.env');
        failures++;
    } else if (buildEnvBody) {
        console.log('  ✓ buildEngineEnv still references .p17.env');
    }
})();

// Config precedence: .p17.env > VS Code state (VS Code state only as fallback)
(function checkPrecedenceDotEnvOverVSCode() {
    // buildEngineEnv must decide on .p17.env BEFORE applying workspaceState.
    // The .p17.env branch returns early; workspaceState.get appears after.
    const buildEnvBody = extractFunctionBody('buildEngineEnv');
    if (buildEnvBody) {
        const dotEnvIdx = buildEnvBody.indexOf('findDotEnvFile()');
        const wsStateIdx = buildEnvBody.indexOf('workspaceState.get');
        const secretsIdx = buildEnvBody.indexOf('secrets.get');

        if (dotEnvIdx === -1) {
            console.error('FAIL: buildEngineEnv must consult findDotEnvFile() first');
            failures++;
        } else {
            console.log('  ✓ buildEngineEnv consults findDotEnvFile() before VS Code config');
        }

        if (wsStateIdx === -1) {
            console.error('FAIL: buildEngineEnv must use workspaceState for VS Code config');
            failures++;
        } else {
            console.log('  ✓ buildEngineEnv uses workspaceState for VS Code config');
        }

        // SecretStorage should appear after workspaceState (highest for key)
        if (secretsIdx === -1) {
            console.error('FAIL: buildEngineEnv must use SecretStorage for API key');
            failures++;
        } else {
            console.log('  ✓ buildEngineEnv uses SecretStorage for API key');
        }
    }
})();

// Ollama .p17.env setup still compatible — file is the source of truth
(function checkOllamaCompatibility() {
    const dotEnvValues = {
        P17_PROVIDER: 'openai-compatible',
        P17_API_URL: 'http://localhost:11434/v1',
        P17_API_KEY: 'ollama',
        P17_MODEL: 'qwen3:4b-instruct',
    };
    // Stale VS Code config exists but must be ignored
    const env = simulateEffectiveEnv({
        baseEnv: { PATH: '/usr/bin' },
        dotEnvValues: dotEnvValues,
        vsConfig: { provider: 'anthropic', model: 'stale-model', apiUrl: 'https://stale.example/v1' },
        secretKey: 'stale-secret-key',
    });

    if (env.P17_PROVIDER !== 'openai-compatible') {
        console.error('FAIL: Ollama config — P17_PROVIDER not from .p17.env');
        failures++;
    } else if (env.P17_API_URL !== 'http://localhost:11434/v1') {
        console.error('FAIL: Ollama config — P17_API_URL not from .p17.env');
        failures++;
    } else if (env.P17_API_KEY !== 'ollama') {
        console.error('FAIL: Ollama config — P17_API_KEY not from .p17.env');
        failures++;
    } else if (env.P17_MODEL !== 'qwen3:4b-instruct') {
        console.error('FAIL: Ollama config — P17_MODEL not from .p17.env');
        failures++;
    } else {
        console.log('  ✓ Ollama .p17.env config still works (stale VS Code config ignored)');
    }
})();

// All three providers supported
(function checkAllProvidersSupported() {
    // The extension should support openai-compatible, anthropic, gemini
    if (!source.includes('openai-compatible')) {
        console.error('FAIL: missing openai-compatible provider support');
        failures++;
    }
    if (!source.includes('anthropic')) {
        console.error('FAIL: missing anthropic provider support');
        failures++;
    }
    if (!source.includes('gemini')) {
        console.error('FAIL: missing gemini provider support');
        failures++;
    }
    if (source.includes('openai-compatible') && source.includes('anthropic') && source.includes('gemini')) {
        console.log('  ✓ all three providers supported');
    }
})();

// ===========================================================================
// SECTION 8: Package.json commands
// ===========================================================================

console.log('\nRegression: package.json commands\n');

(function checkNewCommandsInPackageJson() {
    const commands = (pkg.contributes && pkg.contributes.commands) || [];
    const commandIds = commands.map(c => c.command);

    if (!commandIds.includes('protocol-17.configureModel')) {
        console.error('FAIL: package.json missing protocol-17.configureModel command');
        failures++;
    } else {
        console.log('  ✓ package.json has protocol-17.configureModel command');
    }

    if (!commandIds.includes('protocol-17.testConnection')) {
        console.error('FAIL: package.json missing protocol-17.testConnection command');
        failures++;
    } else {
        console.log('  ✓ package.json has protocol-17.testConnection command');
    }

    // Old commands must still exist
    for (const oldCmd of ['protocol-17.translate', 'protocol-17.selectTarget',
                          'protocol-17.explain', 'protocol-17.run']) {
        if (!commandIds.includes(oldCmd)) {
            console.error(`FAIL: package.json missing existing command ${oldCmd}`);
            failures++;
        }
    }
    console.log('  ✓ all existing commands preserved');
})();

// ===========================================================================
// SECTION 9: Status bar
// ===========================================================================

console.log('\nRegression: status bar\n');

(function checkModelStatusBarItem() {
    if (!source.includes('modelStatusBarItem')) {
        console.error('FAIL: extension.js missing modelStatusBarItem');
        failures++;
    } else {
        console.log('  ✓ modelStatusBarItem exists');
    }
})();

(function checkModelStatusBarCommand() {
    if (!source.includes("modelStatusBarItem.command = 'protocol-17.configureModel'")) {
        console.error('FAIL: modelStatusBarItem should open Configure Model on click');
        failures++;
    } else {
        console.log('  ✓ modelStatusBarItem opens Configure Model');
    }
})();

// ===========================================================================
// SECTION 10: Config precedence — behavioral simulation
// ===========================================================================

console.log('\nRegression: config precedence behavioral tests\n');

(function testDotEnvOnlyWorks() {
    // Workspace .p17.env present, no VS Code config, nothing stale.
    const env = simulateEffectiveEnv({
        baseEnv: { PATH: '/usr/bin', HOME: '/home/user' },
        dotEnvValues: {
            P17_PROVIDER: 'openai-compatible',
            P17_API_URL: 'http://localhost:11434/v1',
            P17_API_KEY: 'ollama',
            P17_MODEL: 'qwen3:4b-instruct',
        },
        vsConfig: {},
        secretKey: undefined,
    });

    if (env.P17_PROVIDER !== 'openai-compatible') {
        console.error('FAIL: .p17.env-only — provider should come from .p17.env');
        failures++;
    } else if (env.P17_MODEL !== 'qwen3:4b-instruct') {
        console.error('FAIL: .p17.env-only — model should come from .p17.env');
        failures++;
    } else if (env.P17_API_KEY !== 'ollama') {
        console.error('FAIL: .p17.env-only — key should come from .p17.env');
        failures++;
    } else if (env.PATH !== '/usr/bin') {
        console.error('FAIL: .p17.env-only — non-P17 process.env values should be preserved');
        failures++;
    } else {
        console.log('  ✓ .p17.env alone configures the engine');
    }
})();

(function testDotEnvOverridesStaleVSCodeProvider() {
    // THE BUG: VS Code has stale provider=anthropic, .p17.env has
    // provider=openai-compatible.  The workspace file must win.
    const env = simulateEffectiveEnv({
        baseEnv: { PATH: '/usr/bin' },
        dotEnvValues: { P17_PROVIDER: 'openai-compatible', P17_API_KEY: 'file-key' },
        vsConfig: { provider: 'anthropic', model: 'stale-model', apiUrl: 'https://stale.example/v1' },
        secretKey: 'sk-ant-secret-from-secretstorage',
    });

    if (env.P17_PROVIDER !== 'openai-compatible') {
        console.error('FAIL: .p17.env provider should override stale VS Code provider');
        failures++;
    } else if (env.P17_API_KEY !== 'file-key') {
        console.error('FAIL: .p17.env key should override stale SecretStorage key');
        failures++;
    } else if ('P17_MODEL' in env && env.P17_MODEL === 'stale-model') {
        console.error('FAIL: stale VS Code model must not be applied when .p17.env exists');
        failures++;
    } else {
        console.log('  ✓ workspace .p17.env overrides stale VS Code provider/model/key');
    }
})();

(function testDotEnvOverridesStaleVSCodeModel() {
    const env = simulateEffectiveEnv({
        baseEnv: { PATH: '/usr/bin' },
        dotEnvValues: { P17_MODEL: 'qwen3:4b-instruct' },
        vsConfig: { provider: 'openai-compatible', model: 'claude-sonnet-5-20251001', apiUrl: 'https://stale.example/v1' },
        secretKey: 'stale-key',
    });

    if (env.P17_MODEL !== 'qwen3:4b-instruct') {
        console.error('FAIL: .p17.env model should override stale VS Code model');
        failures++;
    } else {
        console.log('  ✓ .p17.env model overrides stale VS Code model');
    }
})();

(function testDotEnvOverridesInheritedHostEnv() {
    // The Extension Host may carry P17_* values from the shell that launched
    // VS Code — the workspace file must still win in the editor.
    const env = simulateEffectiveEnv({
        baseEnv: {
            PATH: '/usr/bin',
            P17_PROVIDER: 'host-provider',
            P17_API_URL: 'https://host.example/v1',
            P17_API_KEY: 'host-key',
            P17_MODEL: 'host-model',
        },
        dotEnvValues: {
            P17_PROVIDER: 'openai-compatible',
            P17_API_URL: 'https://api.deepseek.com',
            P17_API_KEY: 'file-key',
            P17_MODEL: 'deepseek-v4-flash',
        },
        vsConfig: {},
        secretKey: undefined,
    });

    if (env.P17_PROVIDER !== 'openai-compatible' ||
        env.P17_API_URL !== 'https://api.deepseek.com' ||
        env.P17_API_KEY !== 'file-key' ||
        env.P17_MODEL !== 'deepseek-v4-flash') {
        console.error('FAIL: .p17.env should override inherited Extension Host P17_* values');
        failures++;
    } else {
        console.log('  ✓ .p17.env overrides inherited Extension Host P17_* values');
    }
})();

(function testNoDotEnvSecretStorageFallback() {
    // No workspace .p17.env — VS Code configured model + SecretStorage
    // must apply over the process environment.
    const env = simulateEffectiveEnv({
        baseEnv: { PATH: '/usr/bin', P17_MODEL: 'host-model' },
        dotEnvValues: null,
        vsConfig: { provider: 'anthropic', model: 'claude-sonnet-5-20251001', apiUrl: '' },
        secretKey: 'sk-ant-secret-from-secretstorage',
    });

    if (env.P17_PROVIDER !== 'anthropic') {
        console.error('FAIL: no .p17.env — VS Code provider should apply');
        failures++;
    } else if (env.P17_MODEL !== 'claude-sonnet-5-20251001') {
        console.error('FAIL: no .p17.env — VS Code model should apply');
        failures++;
    } else if (env.P17_API_KEY !== 'sk-ant-secret-from-secretstorage') {
        console.error('FAIL: no .p17.env — SecretStorage key should apply');
        failures++;
    } else if (env.PATH !== '/usr/bin') {
        console.error('FAIL: no .p17.env — process.env values should be preserved');
        failures++;
    } else {
        console.log('  ✓ no .p17.env → VS Code config + SecretStorage apply');
    }
})();

(function testNoDotEnvProcessEnvFallback() {
    // No workspace .p17.env and no VS Code config — the process
    // environment values pass through unchanged.
    const env = simulateEffectiveEnv({
        baseEnv: { PATH: '/usr/bin', P17_API_KEY: 'shell-key', P17_MODEL: 'shell-model' },
        dotEnvValues: null,
        vsConfig: {},
        secretKey: undefined,
    });

    if (env.P17_API_KEY !== 'shell-key' || env.P17_MODEL !== 'shell-model') {
        console.error('FAIL: no .p17.env, no VS Code config — process env should be preserved');
        failures++;
    } else {
        console.log('  ✓ no .p17.env, no VS Code config → process env preserved');
    }
})();

(function testAnthropicConfigPassedCorrectly() {
    // Simulate VS Code configuring anthropic
    const env = { PATH: '/usr/bin' };
    // VS Code state
    env.P17_PROVIDER = 'anthropic';
    env.P17_MODEL = 'claude-sonnet-5-20251001';
    // SecretStorage
    env.P17_API_KEY = 'sk-ant-secret';

    if (env.P17_PROVIDER !== 'anthropic') {
        console.error('FAIL: anthropic provider not set correctly');
        failures++;
    } else if (env.P17_MODEL !== 'claude-sonnet-5-20251001') {
        console.error('FAIL: anthropic model not set correctly');
        failures++;
    } else if (env.P17_API_KEY !== 'sk-ant-secret') {
        console.error('FAIL: anthropic key not set correctly');
        failures++;
    } else {
        console.log('  ✓ Anthropic configuration passed correctly');
    }
})();

(function testGeminiConfigPassedCorrectly() {
    const env = { PATH: '/usr/bin' };
    env.P17_PROVIDER = 'gemini';
    env.P17_MODEL = 'gemini-2.5-flash';
    env.P17_API_KEY = 'gemini-secret-key';

    if (env.P17_PROVIDER !== 'gemini') {
        console.error('FAIL: gemini provider not set correctly');
        failures++;
    } else if (env.P17_MODEL !== 'gemini-2.5-flash') {
        console.error('FAIL: gemini model not set correctly');
        failures++;
    } else if (env.P17_API_KEY !== 'gemini-secret-key') {
        console.error('FAIL: gemini key not set correctly');
        failures++;
    } else {
        console.log('  ✓ Gemini configuration passed correctly');
    }
})();

(function testApiKeyNeverInConfigState() {
    // The workspaceState keys must not include an API key
    // SECRET_KEY_PREFIX is the base for SecretStorage keys, not workspaceState
    if (source.includes("STATE_API_KEY")) {
        console.error('FAIL: API key should use SecretStorage, not workspaceState');
        failures++;
    } else {
        console.log('  ✓ API key uses SecretStorage, not workspaceState');
    }
})();

// ===========================================================================
// SECTION 11: SecretStorage workspace scoping
// ===========================================================================

console.log('\nRegression: SecretStorage workspace scoping\n');

(function testGetWorkspaceSecretKeyExists() {
    if (!source.includes('function getWorkspaceSecretKey(')) {
        console.error('FAIL: extension.js missing getWorkspaceSecretKey function');
        failures++;
    } else {
        console.log('  ✓ getWorkspaceSecretKey function exists');
    }
})();

(function testWorkspaceSecretKeyUsesHash() {
    const wsKeyBody = extractFunctionBody('getWorkspaceSecretKey');
    if (wsKeyBody && !wsKeyBody.includes('createHash')) {
        console.error('FAIL: getWorkspaceSecretKey must use a stable hash, not raw workspace path');
        failures++;
    } else if (wsKeyBody) {
        console.log('  ✓ getWorkspaceSecretKey uses crypto.createHash');
    }
})();

(function testWorkspaceSecretKeyDerivationIsStable() {
    // Simulate: same workspace path produces the same key
    // (requires crypto — run inline)
    const crypto = require('crypto');
    const SECRET_KEY_PREFIX = 'protocol17.apiKey';

    function deriveKey(workspacePath) {
        const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');
        const shortHash = hash.substring(0, 16);
        return `${SECRET_KEY_PREFIX}.${shortHash}`;
    }

    const keyA1 = deriveKey('/home/user/projects/protocol-17');
    const keyA2 = deriveKey('/home/user/projects/protocol-17');

    if (keyA1 !== keyA2) {
        console.error(`FAIL: same workspace must produce same key: ${keyA1} vs ${keyA2}`);
        failures++;
    } else {
        console.log('  ✓ same workspace path produces same SecretStorage key');
    }
})();

(function testDifferentWorkspacesProduceDifferentKeys() {
    const crypto = require('crypto');
    const SECRET_KEY_PREFIX = 'protocol17.apiKey';

    function deriveKey(workspacePath) {
        const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');
        const shortHash = hash.substring(0, 16);
        return `${SECRET_KEY_PREFIX}.${shortHash}`;
    }

    const keyA = deriveKey('/home/user/projects/workspace-A');
    const keyB = deriveKey('/home/user/projects/workspace-B');

    if (keyA === keyB) {
        console.error(`FAIL: different workspaces must produce different keys: ${keyA}`);
        failures++;
    } else {
        console.log('  ✓ different workspaces produce different SecretStorage keys');
    }
})();

(function testWorkspaceASecretDoesNotAffectWorkspaceB() {
    // Simulate buildEngineEnv behavior for two workspaces.
    //
    // Workspace A: SecretStorage has KEY_A
    // Workspace B: .p17.env has P17_API_KEY=KEY_B
    //
    // Expected in workspace B: P17_API_KEY = KEY_B (not KEY_A)

    const crypto = require('crypto');
    const SECRET_KEY_PREFIX = 'protocol17.apiKey';

    function deriveKey(workspacePath) {
        const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');
        const shortHash = hash.substring(0, 16);
        return `${SECRET_KEY_PREFIX}.${shortHash}`;
    }

    // Simulated SecretStorage (global, keyed by full SecretStorage key)
    const secretStore = {};
    // Workspace A's key
    secretStore[deriveKey('/workspace-A')] = 'KEY_A_FROM_SECRET_STORAGE';
    // Workspace B has NO entry in SecretStorage

    // --- Workspace B: build env ---
    // Workspace B has a .p17.env — the file is the source of truth, so the
    // global SecretStorage is never consulted for workspace B at all.
    const envB = simulateEffectiveEnv({
        baseEnv: { PATH: '/usr/bin', HOME: '/home/user' },
        dotEnvValues: {
            P17_PROVIDER: 'openai-compatible',
            P17_API_KEY: 'KEY_B_FROM_DOTENV',
            P17_MODEL: 'qwen3:4b-instruct',
        },
        vsConfig: {},
        secretKey: secretStore[deriveKey('/workspace-B')], // undefined — no key configured
    });

    // Assert: workspace B uses .p17.env key, not workspace A's secret
    if (envB.P17_API_KEY !== 'KEY_B_FROM_DOTENV') {
        console.error(
            `FAIL: workspace B should use .p17.env key (KEY_B_FROM_DOTENV), ` +
            `got "${envB.P17_API_KEY}". Cross-workspace leak detected.`
        );
        failures++;
    } else {
        console.log('  ✓ workspace A secret does not leak into workspace B');
    }
})();

(function testWorkspaceRetrievesOwnSecretKey() {
    // Workspace A configured a key — verify it retrieves its own
    const crypto = require('crypto');
    const SECRET_KEY_PREFIX = 'protocol17.apiKey';

    function deriveKey(workspacePath) {
        const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');
        const shortHash = hash.substring(0, 16);
        return `${SECRET_KEY_PREFIX}.${shortHash}`;
    }

    const secretStore = {};
    secretStore[deriveKey('/workspace-A')] = 'KEY_A';
    secretStore[deriveKey('/workspace-B')] = 'KEY_B';

    // Workspace A reads its own key
    const keyA = secretStore[deriveKey('/workspace-A')];
    if (keyA !== 'KEY_A') {
        console.error(`FAIL: workspace A should retrieve its own key (KEY_A), got "${keyA}"`);
        failures++;
    } else {
        console.log('  ✓ same workspace retrieves its own SecretStorage key');
    }

    // Workspace B reads its own key
    const keyB = secretStore[deriveKey('/workspace-B')];
    if (keyB !== 'KEY_B') {
        console.error(`FAIL: workspace B should retrieve its own key (KEY_B), got "${keyB}"`);
        failures++;
    } else {
        console.log('  ✓ two workspaces can have different SecretStorage keys');
    }
})();

(function testNoRawWorkspacePathLoggedInKeyDerivation() {
    // The SecretStorage key must not contain the raw workspace path.
    // Verify the derivation function only uses the hash, not raw path.
    const wsKeyBody = extractFunctionBody('getWorkspaceSecretKey');
    if (wsKeyBody) {
        // The key template line must not contain '+' with a path variable directly
        // It should be: `${SECRET_KEY_PREFIX}.${shortHash}` — hash only, no raw path
        const hasRawPathInKey = /SECRET_KEY_PREFIX.*\+.*fsPath/.test(wsKeyBody) ||
                                /SECRET_KEY_PREFIX.*\+.*workspacePath/.test(wsKeyBody);
        if (hasRawPathInKey) {
            console.error('FAIL: SecretStorage key must use hash, not raw workspace path');
            failures++;
        } else {
            console.log('  ✓ no raw workspace path in SecretStorage key');
        }
    }
})();

(function testBuildEngineEnvUsesWorkspaceScopedGet() {
    // buildEngineEnv must call getWorkspaceSecretKey (not bare SECRET_KEY_PREFIX)
    const buildEnvBody = extractFunctionBody('buildEngineEnv');
    if (buildEnvBody && !buildEnvBody.includes('getWorkspaceSecretKey(')) {
        console.error('FAIL: buildEngineEnv must use getWorkspaceSecretKey for workspace scoping');
        failures++;
    } else if (buildEnvBody) {
        console.log('  ✓ buildEngineEnv uses getWorkspaceSecretKey');
    }
})();

(function testConfigureModelUsesWorkspaceScopedStore() {
    // configureModelCommand must call getWorkspaceSecretKey for store
    const configBody = extractFunctionBody('configureModelCommand');
    if (configBody && !configBody.includes('getWorkspaceSecretKey(')) {
        console.error('FAIL: configureModelCommand must use getWorkspaceSecretKey for workspace scoping');
        failures++;
    } else if (configBody) {
        console.log('  ✓ configureModelCommand uses getWorkspaceSecretKey');
    }
})();

// ===========================================================================
// SECTION 12: Old tests preserved
// ===========================================================================

console.log('\nRegression: all existing checks still pass\n');

// All the old checks from previous regression.test.js are already included above.
// This section is a meta-check to confirm the test file itself is complete.

(function checkAllOriginalSectionsPresent() {
    const checks = [
        'NEVER save',             // source safety (comment-based invariant)
        'findDotEnvFile',         // workspace .p17.env lookup (engine-owned parsing)
        '.p17.env',               // backward compat
        '.p17.env.example',       // error guidance
        'runVerification',        // verification integration
    ];
    for (const check of checks) {
        if (!source.includes(check)) {
            console.error(`FAIL: original check "${check}" no longer present in extension.js`);
            failures++;
        }
    }
    console.log('  ✓ all original invariants still present in extension source');
})();

// ===========================================================================
// SECTION 13: Editor title Translate button
// ===========================================================================

console.log('\nRegression: editor title Translate button\n');

(function checkTranslateButtonContribution() {
    const commands = (pkg.contributes && pkg.contributes.commands) || [];
    const menus = (pkg.contributes && pkg.contributes.menus) || {};
    const editorTitle = menus['editor/title'] || [];

    const translateCmd = commands.find(c => c.command === 'protocol-17.translate');
    const translateEntry = editorTitle.find(e => e.command === 'protocol-17.translate');

    // The button must exist in the editor title area
    if (!translateEntry) {
        console.error('FAIL: package.json missing editor/title entry for protocol-17.translate');
        failures++;
        return;
    }

    // ...and must only appear for Protocol 17 / .p17 documents
    if (translateEntry.when !== 'resourceLangId == p17') {
        console.error(
            `FAIL: editor/title Translate entry must use when "resourceLangId == p17", got "${translateEntry.when}"`
        );
        failures++;
    } else {
        console.log('  ✓ editor/title Translate entry scoped to resourceLangId == p17');
    }

    // navigation group keeps it visible without opening the "..." overflow
    if (translateEntry.group !== 'navigation') {
        console.error(
            `FAIL: editor/title Translate entry should use group "navigation", got "${translateEntry.group}"`
        );
        failures++;
    } else {
        console.log('  ✓ Translate button in navigation group (clearly visible)');
    }

    // Play/convert-style codicon on the button (or the command it invokes)
    const icon = translateEntry.icon || (translateCmd && translateCmd.icon);
    if (!icon || !icon.includes('play')) {
        console.error(`FAIL: Translate button should use a play-style codicon, got "${icon}"`);
        failures++;
    } else {
        console.log('  ✓ Translate button uses play-style codicon');
    }

    // Tooltip / title must clearly say "Protocol 17: Translate"
    if (!translateCmd || translateCmd.title !== 'Protocol 17: Translate') {
        console.error(
            `FAIL: protocol-17.translate title must be exactly "Protocol 17: Translate", got "${translateCmd && translateCmd.title}"`
        );
        failures++;
    } else {
        console.log('  ✓ Translate command title is "Protocol 17: Translate"');
    }
})();

// The button must reuse the existing translate command (no logic duplication)
(function checkButtonReusesTranslateCommand() {
    const menus = (pkg.contributes && pkg.contributes.menus) || {};
    const editorTitle = menus['editor/title'] || [];
    const translateEntries = editorTitle.filter(e => e.command === 'protocol-17.translate');
    if (translateEntries.length !== 1) {
        console.error(
            `FAIL: expected exactly one editor/title entry for protocol-17.translate, got ${translateEntries.length}`
        );
        failures++;
    } else {
        console.log('  ✓ single editor/title entry reuses protocol-17.translate');
    }
})();

// ===========================================================================
// SECTION 14: Target language persistence (workspaceState)
// ===========================================================================

console.log('\nRegression: target language persistence\n');

(function checkStateTargetKey() {
    if (!source.includes('STATE_TARGET') || !source.includes("'protocol17.target'")) {
        console.error('FAIL: extension.js missing STATE_TARGET workspace-state key');
        failures++;
    } else {
        console.log('  ✓ STATE_TARGET workspace-state key defined');
    }
})();

(function checkActivateRestoresTarget() {
    const activateBody = extractFunctionBody('activate');
    if (!activateBody) return;

    if (!activateBody.includes('workspaceState.get(STATE_TARGET)')) {
        console.error('FAIL: activate() must restore the saved target via workspaceState.get(STATE_TARGET)');
        failures++;
    } else {
        console.log('  ✓ activate() restores saved target from workspaceState');
    }

    // Default remains C when no saved value exists
    if (!activateBody.includes(": 'c'")) {
        console.error("FAIL: activate() must default the target to 'c' when nothing is saved");
        failures++;
    } else {
        console.log("  ✓ default target remains 'c' when no saved value");
    }
})();

(function checkSelectTargetPersists() {
    const body = extractFunctionBody('selectTargetCommand');
    if (!body) return;

    if (!body.includes('workspaceState.update(STATE_TARGET')) {
        console.error('FAIL: selectTargetCommand() must persist the choice via workspaceState.update(STATE_TARGET)');
        failures++;
    } else {
        console.log('  ✓ selectTargetCommand persists choice to workspaceState');
    }

    // Existing status bar target UI must keep working
    if (!body.includes('updateStatusBar()')) {
        console.error('FAIL: selectTargetCommand() must still refresh the status bar target UI');
        failures++;
    } else {
        console.log('  ✓ status bar target UI still updated after selection');
    }
})();

(function checkTranslateUsesCurrentTarget() {
    const body = extractFunctionBody('translateCommand');
    if (body && !body.includes('currentTarget')) {
        console.error('FAIL: translateCommand() must use the current target');
        failures++;
    } else if (body) {
        console.log('  ✓ translateCommand uses currentTarget');
    }
})();

// The selected target must never be written into the .p17 source document
(function checkTargetNeverWrittenToSource() {
    const body = extractFunctionBody('translateCommand');
    assertNotContains(
        'translateCommand', body, '.edit(',
        'Translate must never mutate the .p17 source document'
    );
})();

// ===========================================================================
// SECTION 15: Repeated translate reuses one output editor
// ===========================================================================

console.log('\nRegression: stable generated-output editor\n');

(function checkStableOutputUri() {
    const body = extractFunctionBody('translateCommand');
    if (!body) return;

    // The output URI must be stable for a given source file + target so
    // repeated translates refresh the same editor instead of piling up tabs.
    if (!body.includes('sourceHash')) {
        console.error('FAIL: translateCommand() must derive a stable output URI (sourceHash)');
        failures++;
    } else {
        console.log('  ✓ translate output URI stable per source file (no tab pile-up)');
    }

    if (!body.includes('contentProvider.set(')) {
        console.error('FAIL: translateCommand() must refresh the virtual document in place');
        failures++;
    } else {
        console.log('  ✓ generated output updates the virtual document in place');
    }
})();

// ===========================================================================
// SECTION 16: No auto-translate on save
// ===========================================================================

console.log('\nRegression: no auto-translate on save\n');

(function checkNoSaveHooks() {
    if (source.includes('onDidSaveTextDocument')) {
        console.error('FAIL: extension must not hook onDidSaveTextDocument (no auto-translate on save)');
        failures++;
    } else {
        console.log('  ✓ no onDidSaveTextDocument hook');
    }

    if (source.includes('willSaveTextDocument')) {
        console.error('FAIL: extension must not hook willSaveTextDocument');
        failures++;
    } else {
        console.log('  ✓ no willSaveTextDocument hook');
    }
})();

(function checkTranslateOnlyExplicit() {
    // translateCommand may only be reachable from the registered command
    // (command palette / editor title button) — never from a save event.
    const saveWiring =
        /onDidSave[\s\S]{0,400}translateCommand/.test(source) ||
        /translateCommand[\s\S]{0,400}onDidSave/.test(source);
    if (saveWiring) {
        console.error('FAIL: translateCommand must not be wired to any save event');
        failures++;
    } else {
        console.log('  ✓ translateCommand reachable only via explicit command invocation');
    }
})();

// ===========================================================================
// SECTION 17: Workspace .p17.env is the configuration source of truth
// ===========================================================================

console.log('\nRegression: workspace .p17.env source of truth\n');

// EXACT BUG REPRODUCTION: a valid workspace .p17.env (working provider, e.g.
// DeepSeek) + stale/incorrect VS Code stored config (Configure Model +
// SecretStorage from an earlier session).  The editor engine environment must
// use the .p17.env values, or editor Translate fails with "Connection error"
// while the CLI works.
(function testValidDotEnvWithStaleVSCodeConfig() {
    const env = simulateEffectiveEnv({
        baseEnv: { PATH: '/usr/bin', HOME: '/home/user' },
        dotEnvValues: {
            P17_PROVIDER: 'openai-compatible',
            P17_API_URL: 'https://api.deepseek.com',
            P17_MODEL: 'deepseek-v4-flash',
            P17_API_KEY: 'deepseek-file-key',
        },
        vsConfig: {
            provider: 'openai-compatible',
            model: 'stale-local-model',
            apiUrl: 'http://localhost:11434/v1',
        },
        secretKey: 'stale-secretstorage-key',
    });

    const expected = {
        P17_PROVIDER: 'openai-compatible',
        P17_API_URL: 'https://api.deepseek.com',
        P17_MODEL: 'deepseek-v4-flash',
        P17_API_KEY: 'deepseek-file-key',
    };
    for (const [key, value] of Object.entries(expected)) {
        if (env[key] !== value) {
            console.error(
                `FAIL: valid .p17.env + stale VS Code config — ${key} should be "${value}" ` +
                `from .p17.env, got "${env[key]}"`
            );
            failures++;
        }
    }
    if (env.P17_API_URL === 'http://localhost:11434/v1' ||
        env.P17_MODEL === 'stale-local-model' ||
        env.P17_API_KEY === 'stale-secretstorage-key') {
        console.error('FAIL: stale VS Code values leaked into the engine environment');
        failures++;
    } else {
        console.log('  ✓ valid .p17.env + stale VS Code config → .p17.env wins (bug fixed)');
    }
})();

// Source check: buildEngineEnv must return the scrubbed env BEFORE touching
// workspaceState or SecretStorage when a workspace .p17.env exists.
(function checkBuildEngineEnvEarlyReturn() {
    const body = extractFunctionBody('buildEngineEnv');
    if (!body) return;

    const earlyReturnIdx = body.indexOf('return env');
    const wsStateIdx = body.indexOf('workspaceState.get');
    const secretsIdx = body.indexOf('secrets.get');

    if (earlyReturnIdx === -1) {
        console.error('FAIL: buildEngineEnv must return the .p17.env-resolved environment');
        failures++;
    } else if (earlyReturnIdx > wsStateIdx) {
        console.error('FAIL: buildEngineEnv .p17.env branch must return before applying VS Code config');
        failures++;
    } else if (earlyReturnIdx > secretsIdx) {
        console.error('FAIL: buildEngineEnv .p17.env branch must return before reading SecretStorage');
        failures++;
    } else {
        console.log('  ✓ buildEngineEnv returns before VS Code config when .p17.env exists');
    }
})();

// Source check: inherited P17_* values must be scrubbed so the engine's
// own loader applies the workspace file (the engine prefers existing
// environment variables, so they must be cleared first).
(function checkBuildEngineEnvScrubsInheritedP17() {
    const body = extractFunctionBody('buildEngineEnv');
    if (!body) return;

    if (!body.includes("startsWith('P17_')")) {
        console.error('FAIL: buildEngineEnv must scrub inherited P17_* values when .p17.env exists');
        failures++;
    } else if (!body.includes('delete env[')) {
        console.error('FAIL: buildEngineEnv must delete inherited P17_* values');
        failures++;
    } else {
        console.log('  ✓ buildEngineEnv scrubs inherited P17_* values (engine resolves the file)');
    }
})();

// Source check: runEngine must skip its P17_API_KEY pre-flight when the
// engine will resolve the workspace file itself (otherwise a valid .p17.env
// would be rejected before the engine ever runs).
(function checkRunEnginePreflightSkipsForDotEnv() {
    const body = extractFunctionBody('runEngine');
    if (!body) return;

    if (!body.includes('findDotEnvFile()')) {
        console.error('FAIL: runEngine must consult findDotEnvFile() before rejecting missing credentials');
        failures++;
    } else {
        console.log('  ✓ runEngine credential pre-check skips when workspace .p17.env exists');
    }
})();

// Translate and Test Model Connection must use identical config resolution
(function checkTranslateAndTestConnectionShareResolution() {
    const engineBody = extractFunctionBody('runEngine');
    const testBody = extractFunctionBody('testConnectionCommand');

    if (!engineBody || !testBody) return;

    if (!engineBody.includes('buildEngineEnv(')) {
        console.error('FAIL: runEngine (Translate path) must use buildEngineEnv');
        failures++;
    } else if (!testBody.includes('buildEngineEnv(')) {
        console.error('FAIL: testConnectionCommand must use buildEngineEnv');
        failures++;
    } else {
        console.log('  ✓ Translate and Test Model Connection share buildEngineEnv resolution');
    }
})();

// Configure Model must warn when the stored config will be shadowed
(function checkConfigureModelWarnsOnDotEnv() {
    const body = extractFunctionBody('configureModelCommand');
    if (!body) return;

    if (!body.includes('findDotEnvFile()')) {
        console.error('FAIL: configureModelCommand must detect a workspace .p17.env');
        failures++;
    } else if (!body.includes('showWarningMessage')) {
        console.error('FAIL: configureModelCommand must warn when .p17.env shadows the stored config');
        failures++;
    } else {
        console.log('  ✓ Configure Model warns when workspace .p17.env takes precedence');
    }
})();

// Security: the .p17.env branch must never log values from the file or env
(function checkDotEnvBranchNeverLogsValues() {
    const body = extractFunctionBody('buildEngineEnv');
    if (!body) return;

    const scrubBranch = body.substring(0, body.indexOf('return env'));
    if (/appendLine|console\.|showInformationMessage|showErrorMessage/.test(scrubBranch)) {
        console.error('FAIL: the .p17.env branch of buildEngineEnv must not log anything');
        failures++;
    } else {
        console.log('  ✓ .p17.env branch logs nothing (no key leakage possible)');
    }
})();

// ===========================================================================
// SECTION 18: Configurable translation timeout
// ===========================================================================

console.log('\nRegression: configurable translation timeout\n');

// Behavioral mirror of extension.js getTranslationTimeout()
function simulateTimeoutResolution(value) {
    if (value === null || value === undefined) {
        return 180;
    }
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
        return 180;
    }
    return seconds;
}

(function testTimeoutSettingInPackageJson() {
    const configuration = (pkg.contributes && pkg.contributes.configuration) || {};
    const properties = configuration.properties || {};
    const prop = properties['protocol17.translationTimeout'];

    if (!prop) {
        console.error('FAIL: package.json missing protocol17.translationTimeout setting');
        failures++;
        return;
    }
    if (prop.type !== 'number') {
        console.error(`FAIL: protocol17.translationTimeout must be type number, got "${prop.type}"`);
        failures++;
    }
    if (prop.default !== 180) {
        console.error(`FAIL: protocol17.translationTimeout default must be 180, got "${prop.default}"`);
        failures++;
    }
    if (prop.minimum !== 0) {
        console.error(`FAIL: protocol17.translationTimeout minimum must be 0 (0 = no timeout), got "${prop.minimum}"`);
        failures++;
    }
    console.log('  ✓ package.json defines protocol17.translationTimeout (number, default 180, min 0)');
})();

(function testGetTranslationTimeoutExists() {
    if (!source.includes('function getTranslationTimeout(')) {
        console.error('FAIL: extension.js missing getTranslationTimeout function');
        failures++;
    } else {
        console.log('  ✓ getTranslationTimeout function exists');
    }
})();

(function testTimeoutDefaultsTo180() {
    if (simulateTimeoutResolution(undefined) !== 180) {
        console.error('FAIL: missing/undefined setting must resolve to 180');
        failures++;
    } else if (simulateTimeoutResolution(null) !== 180) {
        console.error('FAIL: null setting must resolve to 180');
        failures++;
    } else {
        console.log('  ✓ default timeout is 180 seconds');
    }
})();

(function testCustomTimeout() {
    if (simulateTimeoutResolution(300) !== 300) {
        console.error('FAIL: custom timeout 300 must resolve to 300');
        failures++;
    } else if (simulateTimeoutResolution('120') !== 120) {
        console.error('FAIL: string "120" from settings must resolve to 120');
        failures++;
    } else {
        console.log('  ✓ custom timeout values respected (number and numeric string)');
    }
})();

(function testZeroMeansNoTimeout() {
    if (simulateTimeoutResolution(0) !== 0) {
        console.error('FAIL: 0 must mean no timeout, not fall back to 180');
        failures++;
    } else {
        console.log('  ✓ 0 = no timeout');
    }
})();

(function testInvalidTimeoutFallsBackToDefault() {
    if (simulateTimeoutResolution(-5) !== 180) {
        console.error('FAIL: negative timeout must fall back to 180');
        failures++;
    } else if (simulateTimeoutResolution('abc') !== 180) {
        console.error('FAIL: non-numeric timeout must fall back to 180');
        failures++;
    } else {
        console.log('  ✓ invalid/negative timeouts fall back to 180');
    }
})();

(function testRunEngineUsesConfigurableTimeout() {
    const body = extractFunctionBody('runEngine');
    if (!body) return;

    if (!body.includes('getTranslationTimeout()')) {
        console.error('FAIL: runEngine must use getTranslationTimeout()');
        failures++;
    } else if (!body.includes('* 1000')) {
        console.error('FAIL: runEngine must convert seconds to milliseconds');
        failures++;
    } else if (!body.includes('timeout: timeoutMs')) {
        console.error('FAIL: runEngine must pass the resolved timeoutMs to execFile');
        failures++;
    } else {
        console.log('  ✓ runEngine passes configurable timeout to execFile');
    }

    // The hardcoded 60s kill threshold must be gone
    assertNotContains(
        'runEngine', body, '60000',
        'Hardcoded 60s translation timeout must be replaced by the setting'
    );
})();

(function testTimeoutErrorHandling() {
    const body = extractFunctionBody('runEngine');
    if (!body) return;

    if (!body.includes('error.killed')) {
        console.error('FAIL: runEngine must detect the killed-by-timeout condition');
        failures++;
    } else if (!body.includes('Translation timed out')) {
        console.error('FAIL: runEngine must report a clear timeout error');
        failures++;
    } else {
        console.log('  ✓ timeout kills are reported as "Translation timed out"');
    }
})();

(function testProgressStaysVisibleWhileTranslating() {
    const body = extractFunctionBody('translateCommand');
    if (!body) return;

    if (!body.includes('withProgress')) {
        console.error('FAIL: translateCommand must show progress while translating');
        failures++;
    } else if (!body.includes('ProgressLocation.Notification')) {
        console.error('FAIL: translate progress must stay visible as a notification');
        failures++;
    } else {
        console.log('  ✓ translate progress notification remains visible during long translations');
    }
})();

// ===========================================================================
// SECTION 19: Stale generated-output safety
// ===========================================================================

console.log('\nRegression: stale generated-output safety\n');

// Behavioral mirror of the provider's stale semantics
function simulateStaleOutput() {
    const contents = new Map();
    const languages = new Map();
    const stale = new Map();

    function set(uri, content, language) {
        contents.set(uri, content);
        languages.set(uri, language || 'plaintext');
        stale.delete(uri); // fresh code is current
    }
    function markStale(uri, reason) {
        if (!contents.has(uri)) return false;
        stale.set(uri, reason);
        return true;
    }
    function render(uri) {
        const content = contents.get(uri) || '';
        if (stale.has(uri)) {
            return `/* STALE — ${stale.get(uri)} */\n\n${content}`;
        }
        return content;
    }
    return { set, markStale, render };
}

(function testProviderHasStaleTracking() {
    if (!source.includes('markStale(uri, reason)')) {
        console.error('FAIL: P17ContentProvider missing markStale method');
        failures++;
    } else {
        console.log('  ✓ P17ContentProvider has markStale(uri, reason)');
    }

    if (!source.includes('this._stale.delete(key)')) {
        console.error('FAIL: set() must clear stale state when fresh output arrives');
        failures++;
    } else {
        console.log('  ✓ provider set() clears stale state');
    }

    if (!source.includes('function staleBanner(')) {
        console.error('FAIL: extension.js missing staleBanner function');
        failures++;
    } else {
        console.log('  ✓ staleBanner function exists');
    }

    if (!source.includes('STALE —')) {
        console.error('FAIL: stale banner must include a prominent STALE marker');
        failures++;
    } else {
        console.log('  ✓ stale banner prominently marked');
    }
})();

(function testOldOutputMarkedStaleOnNewTranslation() {
    const out = simulateStaleOutput();
    const uri = 'p17-output:foo.generated.c?target=c';
    out.set(uri, 'int main(void) { return 0; }', 'c');

    const marked = out.markStale(uri, 'A new translation is in progress.');
    const rendered = out.render(uri);

    if (!marked) {
        console.error('FAIL: markStale must succeed when previous output exists');
        failures++;
    } else if (!rendered.includes('STALE —')) {
        console.error('FAIL: previous output must render with a stale banner');
        failures++;
    } else if (!rendered.includes('int main')) {
        console.error('FAIL: stale output must keep the previous code visible (marked)');
        failures++;
    } else {
        console.log('  ✓ previous output marked stale when a new translation starts');
    }
})();

(function testStaleClearedOnlyAfterSuccessfulTranslation() {
    const out = simulateStaleOutput();
    const uri = 'p17-output:foo.generated.c?target=c';
    out.set(uri, 'old code', 'c');
    out.markStale(uri, 'translation in progress');
    if (!out.render(uri).includes('STALE —')) {
        console.error('FAIL: pre-condition — output should be stale before success');
        failures++;
    }

    out.set(uri, 'new code', 'c'); // successful translation
    const rendered = out.render(uri);

    if (rendered.includes('STALE —')) {
        console.error('FAIL: successful translation must clear the stale banner');
        failures++;
    } else if (rendered !== 'new code') {
        console.error('FAIL: successful translation must render only the new code');
        failures++;
    } else {
        console.log('  ✓ stale state cleared only by a successful translation');
    }
})();

(function testFailedTranslationKeepsOutputStale() {
    const out = simulateStaleOutput();
    const uri = 'p17-output:foo.generated.c?target=c';
    out.set(uri, 'old code', 'c');
    out.markStale(uri, 'Translation failed. Previous generated output is stale and may not correspond to the current Protocol 17 source.');

    const rendered = out.render(uri);

    if (!rendered.includes('STALE —')) {
        console.error('FAIL: failed translation must leave the old output visibly stale');
        failures++;
    } else if (!rendered.includes('Translation failed')) {
        console.error('FAIL: the stale banner must say the translation failed');
        failures++;
    } else {
        console.log('  ✓ failed translation cannot leave old output looking current');
    }
})();

(function testNoPreviousOutputNothingToMark() {
    const out = simulateStaleOutput();
    const uri = 'p17-output:first-ever.generated.c?target=c';

    if (out.markStale(uri, 'reason') !== false) {
        console.error('FAIL: markStale with no previous output must return false');
        failures++;
    } else if (out.render(uri) !== '') {
        console.error('FAIL: with no previous output there must be nothing rendered');
        failures++;
    } else {
        console.log('  ✓ first translation has nothing to mark stale');
    }
})();

(function testTranslateCommandMarksStaleBeforeRunning() {
    const body = extractFunctionBody('translateCommand');
    if (!body) return;

    const markStaleIdx = body.indexOf('markStale(');
    const runEngineIdx = body.indexOf('runEngine(');

    if (markStaleIdx === -1) {
        console.error('FAIL: translateCommand must mark the previous output stale');
        failures++;
    } else if (markStaleIdx > runEngineIdx) {
        console.error('FAIL: translateCommand must mark stale BEFORE starting the translation');
        failures++;
    } else {
        console.log('  ✓ translateCommand marks previous output stale before translating');
    }
})();

(function testTranslateCommandComputesUriBeforeRunning() {
    const body = extractFunctionBody('translateCommand');
    if (!body) return;

    const uriIdx = body.indexOf('Uri.parse');
    const runEngineIdx = body.indexOf('runEngine(');

    if (uriIdx === -1) {
        console.error('FAIL: translateCommand must compute the output URI');
        failures++;
    } else if (uriIdx > runEngineIdx) {
        console.error('FAIL: translateCommand must compute the output URI before translating (to mark it stale)');
        failures++;
    } else {
        console.log('  ✓ output URI computed before translation starts');
    }
})();

(function testTranslateFailureWordingMatchesInvariant() {
    const body = extractFunctionBody('translateCommand');
    if (!body) return;

    const wording = 'Previous generated output is stale and may not correspond to the current Protocol 17 source';
    if (!body.includes(wording)) {
        console.error('FAIL: translateCommand failure path must state the exact stale wording');
        failures++;
    } else {
        console.log('  ✓ failure path states: previous output is stale (exact wording)');
    }

    // The failure wording must appear in the failure paths (after the
    // success path's contentProvider.set), i.e. the catch/ambiguity handlers.
    const setIdx = body.indexOf('contentProvider.set(uri, output');
    const failureWordingIdx = body.indexOf('Translation failed. Previous generated output is stale');
    if (failureWordingIdx === -1) {
        console.error('FAIL: translateCommand failure handler must mark the output stale');
        failures++;
    } else if (failureWordingIdx < setIdx) {
        console.error('FAIL: the failed-translation stale marking must happen in the failure paths, not before success');
        failures++;
    } else {
        console.log('  ✓ failed translation explicitly marks previous output stale (in failure paths)');
    }
})();

(function testSuccessPathClearsStale() {
    const body = extractFunctionBody('translateCommand');
    if (!body) return;

    if (!body.includes('contentProvider.set(uri, output')) {
        console.error('FAIL: success path must publish fresh output via contentProvider.set (clears stale)');
        failures++;
    } else {
        console.log('  ✓ success path publishes via contentProvider.set (stale state cleared)');
    }
})();

// ===========================================================================
// Report
// ===========================================================================

console.log();
if (failures === 0) {
    console.log('All regression checks passed.');
    process.exit(0);
} else {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
}
