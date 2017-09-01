'use strict';
import {
    workspace, languages, window, commands, debug,
    ExtensionContext, Disposable, QuickPickItem, Uri, Event, EventEmitter,
    DebugConfiguration, DebugSession
} from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { format } from 'util';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as startup from './startup';

interface ProvideContentResponse extends DebugProtocol.Response {
    body: {
        content: string;
    }
}

// Association between DebugSession.id's and AdapterProcess'es.
var activeSessions: { [key: string]: startup.AdapterProcess; } = {};
// Adapter process we've just launched.
var launchedAdapter: startup.AdapterProcess = null;

export function activate(context: ExtensionContext) {
    context.subscriptions.push(commands.registerCommand('lldb.getAdapterExecutable',
        () => startup.getAdapterExecutable(context)));
    context.subscriptions.push(commands.registerCommand('lldb.startDebugSession',
        (args) => startDebugSession(context, args)));
    context.subscriptions.push(commands.registerCommand('lldb.showDisassembly',
        () => showDisassembly(context)));
    context.subscriptions.push(commands.registerCommand('lldb.toggleDisassembly',
        () => toggleDisassembly(context)));
    context.subscriptions.push(commands.registerCommand('lldb.displayFormat',
        () => displayFormat(context)));
    context.subscriptions.push(commands.registerCommand('lldb.launchDebugServer',
        () => startup.launchDebugServer(context)));
    context.subscriptions.push(commands.registerCommand('lldb.diagnose',
        () => startup.diagnose()));
    context.subscriptions.push(commands.registerCommand('lldb.pickProcess',
        () => pickProcess(context, false)));
    context.subscriptions.push(commands.registerCommand('lldb.pickMyProcess',
        () => pickProcess(context, true)));
    context.subscriptions.push(workspace.registerTextDocumentContentProvider('debugger', {
        get onDidChange(): Event<Uri> {
            return previewContentChanged.event;
        },
        async provideTextDocumentContent(uri): Promise<string> {
            return provideHtmlContent(uri);
        }
    }));

    debug.onDidStartDebugSession(session => {
        if (session.type == 'lldb' && launchedAdapter) {
            activeSessions[session.id] = launchedAdapter;
            launchedAdapter = null;
        }
    });
    debug.onDidTerminateDebugSession(session => {
        if (session.type == 'lldb') {
            let adapter = activeSessions[session.id];
            if (adapter) {
                adapter.terminate();
            }
        }
    });
    debug.onDidReceiveDebugSessionCustomEvent(e => {
        if (e.session.type == 'lldb') {
            if (e.event = 'displayHtml') {
                onDisplayHtml(e.body);
            }
        }
    });
}

// Invoked by VSCode to initiate a new debugging session.
async function startDebugSession(context: ExtensionContext, config: DebugConfiguration) {
    if (!context.globalState.get('lldb_works')) {
        window.showInformationMessage("Since this is the first time you are starting LLDB, I'm going to run some quick diagnostics...");
        let succeeded = await startup.diagnose();
        context.globalState.update('lldb_works', succeeded);
        if (!succeeded)
            return;
    }
    try {
        if (launchedAdapter) {
            // Clean up the last process, if onDidStartDebugSession didn't fire for some reason.
            launchedAdapter.terminate();
        }
        let adapter = await startup.startDebugAdapter(context);
        config.debugServer = adapter.port;
        launchedAdapter = adapter;
        await commands.executeCommand('vscode.startDebug', config);
    } catch (err) {
        startup.analyzeStartupError(err);
    }
}

async function showDisassembly(context: ExtensionContext) {
    if (debug.activeDebugSession && debug.activeDebugSession.type == 'lldb') {
        let selection = await window.showQuickPick(['always', 'auto', 'never']);
        debug.activeDebugSession.customRequest('showDisassembly', { value: selection });
    }
}

async function toggleDisassembly(context: ExtensionContext) {
    if (debug.activeDebugSession && debug.activeDebugSession.type == 'lldb') {
        debug.activeDebugSession.customRequest('showDisassembly', { value: 'toggle' });
    }
}

async function displayFormat(context: ExtensionContext) {
    if (debug.activeDebugSession && debug.activeDebugSession.type == 'lldb') {
        let selection = await window.showQuickPick(['auto', 'hex', 'decimal', 'binary']);
        debug.activeDebugSession.customRequest('displayFormat', { value: selection });
    }
}

async function pickProcess(context: ExtensionContext, currentUserOnly: boolean): Promise<number> {
    let is_windows = process.platform == 'win32';
    var command: string;
    if (!is_windows) {
        if (currentUserOnly)
            command = 'ps x';
        else
            command = 'ps ax';
    } else {
        if (currentUserOnly)
            command = 'tasklist /V /FO CSV /FI "USERNAME eq ' + process.env['USERNAME'] + '"';
        else
            command = 'tasklist /V /FO CSV';
    }
    let stdout = await new Promise<string>((resolve, reject) => {
        cp.exec(command, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout)
        })
    });
    let lines = stdout.split('\n');
    let items: (QuickPickItem & { pid: number })[] = [];

    var re: RegExp, idx: number[];
    if (!is_windows) {
        re = /^\s*(\d+)\s+.*?\s+.*?\s+.*?\s+(.*)()$/;
        idx = [1, 2, 3];
    } else {
        // name, pid, ..., window title
        re = /^"([^"]*)","([^"]*)",(?:"[^"]*",){6}"([^"]*)"/;
        idx = [2, 1, 3];
    }
    for (var i = 1; i < lines.length; ++i) {
        let groups = re.exec(lines[i]);
        if (groups) {
            let pid = parseInt(groups[idx[0]]);
            let name = groups[idx[1]];
            let descr = groups[idx[2]];
            let item = { label: format('%d: %s', pid, name), description: descr, pid: pid };
            items.unshift(item);
        }
    }
    let item = await window.showQuickPick(items);
    if (item) {
        return item.pid;
    } else {
        throw Error('Cancelled');
    }
}

/// HTML display stuff ///

var previewContent: { [key: string]: string; } = {};
var previewContentChanged: EventEmitter<Uri> = new EventEmitter<Uri>();

async function onDisplayHtml(body: any) {
    previewContent = body.content; // Sets a global.
    for (var keyUri in body.content) {
        previewContentChanged.fire(Uri.parse(keyUri));
    }
    await commands.executeCommand('vscode.previewHtml',
        body.uri, body.position, body.title, { allowScripts: true, allowSvgs: true });
}

async function provideHtmlContent(uri: Uri): Promise<string> {
    let uriString = uri.toString();
    if (previewContent.hasOwnProperty(uriString)) {
        return previewContent[uriString];
    }
    let result = await commands.executeCommand<ProvideContentResponse>(
        'workbench.customDebugRequest', 'provideContent', { uri: uriString });
    if (result === undefined) {
        return "Not available";
    } else {
        return result.body.content;
    }
}
