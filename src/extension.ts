import * as path from 'path';
import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

function log(message: string) {
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').slice(0, 23); // YYYY-MM-DD HH:MM:SS.mmm
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

export async function activate(context: vscode.ExtensionContext) {
    // Create output channel for logs
    outputChannel = vscode.window.createOutputChannel('TableGen');
    context.subscriptions.push(outputChannel);
    log('TableGen extension activating...');

    // Create status bar item with id so it appears in context menu
    statusBarItem = vscode.window.createStatusBarItem(
        'tablegen.status',
        vscode.StatusBarAlignment.Left,
        100
    );
    statusBarItem.name = 'TableGen';
    statusBarItem.text = '$(file-code) TableGen';
    statusBarItem.tooltip = 'TableGen Language Server';
    statusBarItem.command = 'tablegen.showOutput';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Path to the server module
    const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));
    log(`Server module: ${serverModule}`);

    // Server options - run the server as a Node.js module
    const serverOptions: ServerOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc,
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: {
                execArgv: ['--nolazy', '--inspect=6009'],
            },
        },
    };

    // Client options
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'tablegen' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.td'),
        },
        outputChannel: outputChannel,
    };

    // Create the client
    client = new LanguageClient(
        'tablegen-lsp',
        'TableGen Language Server',
        serverOptions,
        clientOptions
    );

    // Register commands before starting
    context.subscriptions.push(
        vscode.commands.registerCommand('tablegen.restartServer', async () => {
            log('Restarting language server...');
            if (client) {
                await client.stop();
                await client.start();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tablegen.showOutput', () => {
            outputChannel.show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tablegen.reindex', async () => {
            log('Force reindexing...');
            if (client) {
                await client.sendRequest('tablegen/reindex');
            }
        })
    );

    // Start the client and wait for it to be ready
    await client.start();
    log('Language client started');

    // Set up notification handlers after client is ready
    client.onNotification('tablegen/status', (params: { message: string; type: 'progress' | 'ready' | 'error' }) => {
        if (params.type === 'progress') {
            statusBarItem.text = `$(sync~spin) ${params.message}`;
            statusBarItem.tooltip = 'TableGen indexing in progress - click to show output';
        } else if (params.type === 'ready') {
            statusBarItem.text = `$(check) ${params.message}`;
            statusBarItem.tooltip = 'TableGen - click to show output';
            // After 5 seconds, show just the icon
            setTimeout(() => {
                statusBarItem.text = '$(file-code) TableGen';
                statusBarItem.tooltip = 'TableGen Language Server - click to show output';
            }, 5000);
        } else if (params.type === 'error') {
            statusBarItem.text = `$(error) ${params.message}`;
            statusBarItem.tooltip = 'TableGen error - click to show output';
        }
    });

    client.onNotification('tablegen/log', (params: { message: string }) => {
        log(`[Server] ${params.message}`);
    });

    log('TableGen extension activated');
}

export async function deactivate(): Promise<void> {
    if (client) {
        await client.stop();
    }
}
