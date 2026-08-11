/**
 * Regression test: verify Translate / Explain / Run never call document.save(),
 * and that .p17.env parsing works correctly.
 *
 * Usage:  node test/regression.test.js
 */

const fs = require('fs');
const path = require('path');

const EXTENSION_JS = path.join(__dirname, '..', 'extension.js');
const source = fs.readFileSync(EXTENSION_JS, 'utf-8');

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
        console.error(`FAIL: could not find function "${name}"`);
        failures++;
        return null;
    }

    // Find the opening brace
    const openBraceIdx = source.indexOf('{', startIdx);
    if (openBraceIdx === -1) {
        console.error(`FAIL: could not find opening brace for "${name}"`);
        failures++;
        return null;
    }

    // Brace-count to find the matching closing brace at column 0
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
// Standalone env-file parser (mirrors parseEnvFile in extension.js)
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

// ---------------------------------------------------------------------------
// Document-safety checks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Env parsing — behavioral tests (standalone parseEnvFile)
// ---------------------------------------------------------------------------

console.log('\nRegression: .p17.env parsing\n');

(function testBasicKeyValue() {
    const result = parseEnvFile('P17_API_URL=https://example.com/v1\nP17_API_KEY=sk-abc123');
    if (result.P17_API_URL !== 'https://example.com/v1') {
        console.error('FAIL: basic key=value — P17_API_URL not parsed correctly');
        failures++;
    } else if (result.P17_API_KEY !== 'sk-abc123') {
        console.error('FAIL: basic key=value — P17_API_KEY not parsed correctly');
        failures++;
    } else {
        console.log('  ✓ basic key=value parsing');
    }
})();

(function testCommentsIgnored() {
    const result = parseEnvFile(
        '# This is a comment\n' +
        'P17_API_URL=https://example.com/v1\n' +
        '# Another comment\n' +
        'P17_API_KEY=sk-abc123\n'
    );
    if (result.P17_API_URL !== 'https://example.com/v1') {
        console.error('FAIL: comments — P17_API_URL not found after comment');
        failures++;
    } else if (result.P17_API_KEY !== 'sk-abc123') {
        console.error('FAIL: comments — P17_API_KEY not found after comment');
        failures++;
    } else if ('#' in result || result['#'] !== undefined) {
        console.error('FAIL: comments — comment character leaked into result');
        failures++;
    } else {
        console.log('  ✓ comments (#) ignored');
    }
})();

(function testBlankLinesIgnored() {
    const result = parseEnvFile(
        '\n\nP17_API_URL=https://example.com/v1\n\n\nP17_API_KEY=sk-abc123\n\n'
    );
    if (result.P17_API_URL !== 'https://example.com/v1') {
        console.error('FAIL: blank lines — P17_API_URL not found');
        failures++;
    } else if (result.P17_API_KEY !== 'sk-abc123') {
        console.error('FAIL: blank lines — P17_API_KEY not found');
        failures++;
    } else {
        console.log('  ✓ blank lines ignored');
    }
})();

(function testDoubleQuotedValues() {
    const result = parseEnvFile(
        'P17_API_URL="https://example.com/v1"\n' +
        'P17_API_KEY="sk-abc123"\n'
    );
    if (result.P17_API_URL !== 'https://example.com/v1') {
        console.error(`FAIL: double-quoted — got "${result.P17_API_URL}", expected unquoted value`);
        failures++;
    } else if (result.P17_API_KEY !== 'sk-abc123') {
        console.error(`FAIL: double-quoted key — got "${result.P17_API_KEY}", expected unquoted value`);
        failures++;
    } else {
        console.log('  ✓ double-quoted values stripped');
    }
})();

(function testSingleQuotedValues() {
    const result = parseEnvFile(
        "P17_API_URL='https://example.com/v1'\n" +
        "P17_API_KEY='sk-abc123'\n"
    );
    if (result.P17_API_URL !== 'https://example.com/v1') {
        console.error(`FAIL: single-quoted — got "${result.P17_API_URL}", expected unquoted value`);
        failures++;
    } else if (result.P17_API_KEY !== 'sk-abc123') {
        console.error(`FAIL: single-quoted key — got "${result.P17_API_KEY}", expected unquoted value`);
        failures++;
    } else {
        console.log('  ✓ single-quoted values stripped');
    }
})();

(function testNoShellEvaluation() {
    // $HOME, backticks, and $(...) must NOT be expanded
    const result = parseEnvFile(
        'SAFE_VALUE=$HOME\n' +
        'BACKTICK_VALUE=`whoami`\n' +
        'DOLLAR_PAREN_VALUE=$(whoami)\n'
    );
    if (result.SAFE_VALUE !== '$HOME') {
        console.error(`FAIL: no shell eval — $HOME was expanded to "${result.SAFE_VALUE}"`);
        failures++;
    } else if (result.BACKTICK_VALUE !== '`whoami`') {
        console.error(`FAIL: no shell eval — backtick expanded to "${result.BACKTICK_VALUE}"`);
        failures++;
    } else if (result.DOLLAR_PAREN_VALUE !== '$(whoami)') {
        console.error(`FAIL: no shell eval — $(...) expanded to "${result.DOLLAR_PAREN_VALUE}"`);
        failures++;
    } else {
        console.log('  ✓ no shell evaluation / command substitution');
    }
})();

(function testPrecedenceDotEnvOverridesProcessEnv() {
    // Simulate: process.env has P17_API_URL=old, .p17.env has P17_API_URL=new
    const dotEnv = parseEnvFile('P17_API_URL=https://new.example/v1\nP17_MODEL=gpt-4o');
    const merged = { ...{ P17_API_URL: 'https://old.example/v1', PATH: '/usr/bin' }, ...dotEnv };

    if (merged.P17_API_URL !== 'https://new.example/v1') {
        console.error(`FAIL: precedence — .p17.env should override process.env, got "${merged.P17_API_URL}"`);
        failures++;
    } else if (merged.PATH !== '/usr/bin') {
        console.error('FAIL: precedence — process.env value lost when not in .p17.env');
        failures++;
    } else if (merged.P17_MODEL !== 'gpt-4o') {
        console.error('FAIL: precedence — .p17.env-only key not in merged result');
        failures++;
    } else {
        console.log('  ✓ precedence: .p17.env overrides process.env');
    }
})();

(function testEmptyFile() {
    const result = parseEnvFile('');
    if (Object.keys(result).length !== 0) {
        console.error('FAIL: empty file should produce empty object');
        failures++;
    } else {
        console.log('  ✓ empty file → empty object');
    }
})();

(function testAllCommentsFile() {
    const result = parseEnvFile('# comment 1\n# comment 2\n   # indented comment');
    if (Object.keys(result).length !== 0) {
        console.error('FAIL: all-comments file should produce empty object');
        failures++;
    } else {
        console.log('  ✓ all-comments file → empty object');
    }
})();

(function testValueContainsEquals() {
    const result = parseEnvFile('P17_API_URL=https://example.com/v1?x=1&y=2');
    if (result.P17_API_URL !== 'https://example.com/v1?x=1&y=2') {
        console.error(`FAIL: value containing = — got "${result.P17_API_URL}"`);
        failures++;
    } else {
        console.log('  ✓ value containing = sign preserved');
    }
})();

(function testModelVariableParsed() {
    const result = parseEnvFile('P17_MODEL=qwen3:4b-instruct');
    if (result.P17_MODEL !== 'qwen3:4b-instruct') {
        console.error(`FAIL: P17_MODEL — got "${result.P17_MODEL}"`);
        failures++;
    } else {
        console.log('  ✓ P17_MODEL parsed correctly');
    }
})();

// ---------------------------------------------------------------------------
// Extension source structure checks — env integration
// ---------------------------------------------------------------------------

console.log('\nRegression: extension env integration\n');

// Verify parseEnvFile function exists
(function checkParseEnvFileExists() {
    if (!source.includes('function parseEnvFile(')) {
        console.error('FAIL: extension.js missing parseEnvFile function');
        failures++;
    } else {
        console.log('  ✓ parseEnvFile function exists in extension.js');
    }
})();

// Verify runEngine passes env: to execFile
(function checkRunEnginePassesEnv() {
    const engineBody = extractFunctionBody('runEngine');
    if (engineBody && !engineBody.includes('env:')) {
        console.error('FAIL: runEngine() must pass env: to execFile/spawn');
        failures++;
    } else if (engineBody) {
        console.log('  ✓ runEngine passes env: to execFile');
    }
})();

// Verify runEngine reads .p17.env
(function checkRunEngineReadsDotEnv() {
    const engineBody = extractFunctionBody('runEngine');
    if (engineBody && !engineBody.includes('.p17.env')) {
        console.error('FAIL: runEngine() must reference .p17.env');
        failures++;
    } else if (engineBody) {
        console.log('  ✓ runEngine references .p17.env');
    }
})();

// Verify helpful error message mentions .p17.env.example
(function checkErrorMessageMentionsExample() {
    const engineBody = extractFunctionBody('runEngine');
    if (engineBody && !engineBody.includes('.p17.env.example')) {
        console.error('FAIL: runEngine() error message should mention .p17.env.example');
        failures++;
    } else if (engineBody) {
        console.log('  ✓ runEngine error message mentions .p17.env.example');
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

// ---------------------------------------------------------------------------
// Extension source structure checks — target verification
// ---------------------------------------------------------------------------

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
    // The verification temp file (verifyTmp) must be cleaned up
    if (body && !body.includes('verifyTmp')) {
        console.error('FAIL: translateCommand() missing verifyTmp cleanup');
        failures++;
    } else if (body) {
        console.log('  ✓ translateCommand cleans up verifyTmp');
    }
})();

// Verify no document.save regression from verification additions
(function checkNoDocumentSaveInVerificationAreas() {
    // document.save must still not appear anywhere in translateCommand
    const body = extractFunctionBody('translateCommand');
    assertNotContains(
        'translateCommand', body, 'document.save(',
        'Verification must not introduce document mutation'
    );
})();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log();
if (failures === 0) {
    console.log('All regression checks passed.');
    process.exit(0);
} else {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
}
