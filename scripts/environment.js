'use strict';

const fs = require('node:fs');
const { parseEnv } = require('node:util');

function parseEnvironmentFile(contents) {
    return parseEnv(String(contents));
}

function loadEnvironmentFile(
    filePath,
    environment = process.env,
    {
        override = false,
        ignoreAccessErrors = false,
        fileSystem = fs,
    } = {}
) {
    if (!fileSystem.existsSync(filePath)) {
        return false;
    }

    let contents;
    try {
        contents = fileSystem.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (ignoreAccessErrors && ['EACCES', 'EPERM'].includes(error.code)) {
            return false;
        }
        throw error;
    }
    const parsed = parseEnvironmentFile(contents);
    for (const [name, value] of Object.entries(parsed)) {
        if (override || !(name in environment)) {
            environment[name] = value;
        }
    }
    return true;
}

module.exports = {
    loadEnvironmentFile,
    parseEnvironmentFile,
};
