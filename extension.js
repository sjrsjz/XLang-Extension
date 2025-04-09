const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } = require('vscode-languageclient/node');

// 保存终端引用
let xlangTerminal = null;
// 保存LSP客户端引用
let langClient = null;

/**
 * 激活扩展时被调用
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('XLang扩展已激活');

    // 启动LSP服务器
    startLSP(context);

    // 注册运行XLang文件的命令
    let disposable = vscode.commands.registerCommand('xlang.run', function () {
        runXLangFile();
    });

    // 监听终端关闭事件，清除引用
    vscode.window.onDidCloseTerminal(terminal => {
        if (xlangTerminal === terminal) {
            xlangTerminal = null;
        }
    });

    // 添加文档变更监听器
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            // 检查是否为 XLang 文件
            if (event.document.languageId === 'xlang' && langClient) {
                console.log('检测到 XLang 文件变更，通知 LSP 服务器');
                // 如果需要，这里可以手动发送通知给 LSP 服务器
            }
        })
    );

    // 添加文档保存监听器
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId === 'xlang' && langClient) {
                console.log('XLang 文件已保存，重新验证文档');
                // 触发文档验证
                langClient.sendNotification('textDocument/didSave', {
                    textDocument: {
                        uri: document.uri.toString(),
                    },
                    text: document.getText()
                });
            }
        })
    );

    context.subscriptions.push(disposable);
}

/**
 * 启动LSP服务器
 * @param {vscode.ExtensionContext} context 
 */
function startLSP(context) {
    // 获取xlang可执行文件路径
    const config = vscode.workspace.getConfiguration('xlang');
    let runtimePath = config.get('runtimePath') || 'XLang-Rust';

    // 解析波浪符号为用户主目录
    if (runtimePath.startsWith('~')) {
        const homedir = require('os').homedir();
        runtimePath = path.join(homedir, runtimePath.substring(1));
    }

    // 检查runtimePath是否为目录，如果是则尝试找到可执行文件
    if (fs.existsSync(runtimePath) && fs.statSync(runtimePath).isDirectory()) {
        // 在Linux/Mac上查找没有扩展名的可执行文件，在Windows上查找.exe文件
        const exeName = process.platform === 'win32' ? 'XLang-Rust.exe' : 'XLang-Rust';
        const possiblePath = path.join(runtimePath, exeName);

        if (fs.existsSync(possiblePath)) {
            console.log(`找到可执行文件: ${possiblePath}`);
            runtimePath = possiblePath;
        } else {
            // 如果是目录但找不到可执行文件，则查找 target/release 子目录
            const releasePath = path.join(runtimePath, 'target', 'release', exeName);
            if (fs.existsSync(releasePath)) {
                console.log(`找到可执行文件: ${releasePath}`);
                runtimePath = releasePath;
            }
        }
    }

    // 检查runtimePath是否存在
    const pathExists = fs.existsSync(runtimePath);
    if (!pathExists) {
        if (path.isAbsolute(runtimePath)) {
            const message = `XLang可执行文件不存在于路径: ${runtimePath}。LSP功能无法正常工作。`;
            vscode.window.showErrorMessage(message);
            console.error(message);
            return; // 如果文件不存在，直接退出函数
        } else {
            console.log(`尝试使用环境变量中的命令: ${runtimePath}`);
        }
    } else {
        console.log(`使用XLang可执行文件: ${runtimePath}`);
    }

    // 定义TCP端口，可以是随机生成的或配置的固定端口
    const lspPort = config.get('lspPort') || 9257; // 默认9257端口，可通过配置修改
    console.log(`LSP将使用端口: ${lspPort}`);

    // 先检查端口是否被占用
    const net = require('net');
    const testServer = net.createServer()
        .once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                const msg = `端口 ${lspPort} 已被占用，请在设置中更改lspPort配置项`;
                vscode.window.showErrorMessage(msg);
                console.error(msg);
                return;
            }
        })
        .once('listening', () => {
            testServer.close(() => {
                // 端口可用，启动LSP服务器
                startActualLSP(context, runtimePath, lspPort);
            });
        })
        .listen(lspPort);
}

/**
 * 实际启动LSP服务器
 */
function startActualLSP(context, runtimePath, lspPort) {
    console.log(`正在启动LSP服务器: ${runtimePath} lsp --port ${lspPort}`);

    // 服务器选项配置 - 使用TCP连接
    const serverOptions = () => {
        return new Promise((resolve, reject) => {
            // 使用详细日志级别启动LSP服务器进程
            const lspProcess = spawn(runtimePath, ['lsp', '--port', lspPort.toString()]);
            let started = false;
            let outputBuffer = '';

            // 处理进程标准输出
            lspProcess.stdout.on('data', (data) => {
                const message = data.toString();
                outputBuffer += message;
                console.log(`LSP服务器输出: ${message.trim()}`);

                // 检查是否有启动成功的信息
                if (message.includes("LSP server started") ||
                    message.includes("服务器已启动") ||
                    message.includes("listening") ||
                    (!started && message.includes("port"))) {

                    console.log(`检测到LSP服务器启动信息，准备连接到端口: ${lspPort}`);
                    started = true;

                    // 等待一小段时间，确保服务器已完全启动
                    setTimeout(() => {
                        try {
                            // 建立TCP socket连接
                            const socket = net.connect(lspPort);

                            socket.on('connect', () => {
                                console.log(`已成功连接到LSP服务器端口: ${lspPort}`);
                            });

                            socket.on('error', (err) => {
                                console.error(`Socket连接错误: ${err.message}`);
                                reject(err);
                            });

                            // 返回reader和writer
                            resolve({
                                reader: socket,
                                writer: socket
                            });
                        } catch (err) {
                            reject(err);
                            console.error(`无法建立TCP连接: ${err.message}`);
                        }
                    }, 1000); // 增加延迟以确保服务器完全启动
                }
            });

            // 处理进程错误输出
            lspProcess.stderr.on('data', (data) => {
                const errMsg = data.toString();
                console.log(`LSP服务器输出: ${errMsg}`);

                // 某些错误信息实际上可能是服务器正常启动的一部分
                if (errMsg.includes("Listening") || errMsg.includes("port")) {
                    started = true;
                    setTimeout(() => {
                        try {
                            const socket = net.connect(lspPort);
                            resolve({
                                reader: socket,
                                writer: socket
                            });
                        } catch (err) {
                            reject(err);
                        }
                    }, 1000);
                }
            });

            // 处理进程退出事件
            lspProcess.on('exit', (code) => {
                if (code !== 0 && !started) {
                    const message = `XLang LSP服务器进程以状态码 ${code} 退出`;
                    console.error(message);
                    reject(new Error(message));
                } else if (started) {
                    console.log(`LSP服务器进程退出，但连接已建立`);
                }
            });

            // 处理进程启动错误
            lspProcess.on('error', (err) => {
                const message = `无法启动XLang LSP服务器: ${err.message}`;
                console.error(message);
                reject(new Error(message));
            });

            // 定时检查是否成功连接
            setTimeout(() => {
                if (!started) {
                    // 超时时打印收集到的所有输出，帮助调试
                    console.error('等待LSP服务器启动超时');
                    console.error('收集到的输出:', outputBuffer);

                    // 尝试使用help命令检查可执行文件是否正常
                    const helpProcess = spawn(runtimePath, ['--help']);
                    helpProcess.stdout.on('data', (data) => {
                        console.log(`XLang帮助输出: ${data.toString()}`);
                    });

                    helpProcess.on('exit', () => {
                        reject(new Error('等待LSP服务器启动超时'));
                        lspProcess.kill();
                    });
                }
            }, 15000); // 增加超时时间至15秒
        });
    };

    const clientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'xlang' },
            { scheme: 'untitled', language: 'xlang' },
            { scheme: 'file', pattern: '**/*.x' }, // 添加文件模式匹配
            { scheme: 'file', pattern: '**/*.xlang' } // 添加更多可能的扩展名
        ],
        synchronize: {
            configurationSection: 'xlang',
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{x,xlang}'), // 支持多种扩展名
            // 添加文档内容变化的同步支持
            textDocumentSync: {
                openClose: true,
                change: 2, // 完整文档同步
                willSave: true,
                willSaveWaitUntil: true,
                save: {
                    includeText: true
                }
            }
        },
        outputChannelName: 'XLang Language Server',
        revealOutputChannelOn: 1
    };
    try {
        // 创建语言客户端
        langClient = new LanguageClient('xlangLanguageServer', 'XLang Language Server', serverOptions, clientOptions);

        // 启动客户端
        const disposable = langClient.start();

        disposable.then(() => {
            vscode.window.showInformationMessage('XLang语言服务器已启动');
            console.log('LSP服务器已成功启动');
        }).catch(error => {
            vscode.window.showErrorMessage(`XLang语言服务器启动失败: ${error.message}`);
            console.error('LSP启动失败:', error);
            langClient.outputChannel.show();
        });

        context.subscriptions.push({
            dispose: () => {
                if (langClient) {
                    langClient.stop();
                }
            }
        });
    } catch (err) {
        console.error('创建LSP客户端时出错:', err);
        vscode.window.showErrorMessage(`无法启动XLang语言服务: ${err.message}`);
    }
}

/**
 * 运行XLang文件
 */
async function runXLangFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('没有打开的编辑器');
        return;
    }

    const document = editor.document;
    if (document.languageId !== 'xlang') {
        vscode.window.showErrorMessage('当前文件不是XLang文件');
        return;
    }

    // 保存文件
    await document.save();
    const filePath = document.fileName;
    const fileDir = path.dirname(filePath);

    // 获取用户配置
    const config = vscode.workspace.getConfiguration('xlang');
    let runtimePath = config.get('runtimePath') || 'XLang-Rust';
    const useFullPath = config.get('useFullPath') || false;
    let workingDir = config.get('workingDirectory') || fileDir;
    const shellType = config.get('shellType') || 'default';

    // 如果使用完整路径但提供的不是绝对路径，尝试找到可执行文件
    if (useFullPath && !path.isAbsolute(runtimePath)) {
        vscode.window.showWarningMessage('您启用了使用完整路径，但提供的路径不是绝对路径');
    }

    // 确定Shell类型
    const isWindows = process.platform === 'win32';
    let isPowerShell = false;

    // 设置Shell类型相关参数
    let terminalOptions = {
        name: 'XLang',
        cwd: workingDir
    };

    if (shellType !== 'default') {
        if (isWindows) {
            if (shellType === 'powershell') {
                terminalOptions.shellPath = 'powershell.exe';
                isPowerShell = true;
            } else if (shellType === 'cmd') {
                terminalOptions.shellPath = 'cmd.exe';
                terminalOptions.shellArgs = ['/C'];
            }
        } else {
            if (shellType === 'bash') {
                terminalOptions.shellPath = '/bin/bash';
            } else if (shellType === 'sh') {
                terminalOptions.shellPath = '/bin/sh';
            }
        }
    } else if (isWindows) {
        // 在Windows上检测默认终端是否为PowerShell
        try {
            const defaultShell = vscode.env.shell;
            isPowerShell = defaultShell && defaultShell.toLowerCase().includes('powershell');
        } catch (error) {
            console.error('无法检测默认Shell:', error);
        }
    }

    // 重用或创建终端
    if (!xlangTerminal) {
        xlangTerminal = vscode.window.createTerminal(terminalOptions);
    }

    // 显示终端
    xlangTerminal.show();

    // 清空终端 (可选)
    // 对于PowerShell
    if (isPowerShell) {
        xlangTerminal.sendText('Clear-Host', true);
    }
    // 对于CMD和其他终端
    else if (isWindows) {
        xlangTerminal.sendText('cls', true);
    } else {
        xlangTerminal.sendText('clear', true);
    }

    // 构建命令 - 根据Shell类型处理路径
    let command = '';

    // 对路径进行处理，确保在不同Shell中正确执行
    if (isWindows) {
        if (isPowerShell) {
            // PowerShell中执行
            if (runtimePath.includes(' ')) {
                command = `& '${runtimePath}' run '${filePath}'`;
            } else {
                command = `${runtimePath} run '${filePath}'`;
            }
        } else {
            // CMD中执行
            command = `${runtimePath} run "${filePath}"`;
        }
    } else {
        // Unix类系统
        if (runtimePath.includes(' ')) {
            command = `"${runtimePath}" run "${filePath}"`;
        } else {
            command = `${runtimePath} run "${filePath}"`;
        }
    }

    // 发送命令到终端
    console.log('执行命令:', command);
    xlangTerminal.sendText(command);

    // 如果遇到问题，提供帮助信息
    if (!fs.existsSync(runtimePath) && path.isAbsolute(runtimePath)) {
        xlangTerminal.sendText('', true);
        xlangTerminal.sendText('# 可执行文件路径不存在，请检查xlang.runtimePath配置', true);
    }
}

function deactivate() {
    // 清理资源
    if (xlangTerminal) {
        xlangTerminal.dispose();
        xlangTerminal = null;
    }

    // 停止LSP客户端
    if (langClient) {
        return langClient.stop();
    }

    return undefined;
}

module.exports = {
    activate,
    deactivate
};