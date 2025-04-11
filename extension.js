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
    // 添加测试命令
    let testDisposable = vscode.commands.registerCommand('xlang.diagnose', () => {
        // 获取当前活动编辑器和文档
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('没有打开的编辑器');
            return;
        }

        const document = editor.document;
        const report = [
            `文件名: ${document.fileName}`,
            `语言ID: ${document.languageId}`,
            `扩展名: ${path.extname(document.fileName)}`,
            `LSP客户端状态: ${langClient ? '已启动' : '未启动'}`,
            `自动补全状态: ${langClient && langClient.initializeResult && 
                langClient.initializeResult.capabilities.completionProvider ? '可用' : '不可用'}`,
            `语义令牌状态: ${langClient && langClient.initializeResult && 
                langClient.initializeResult.capabilities.semanticTokensProvider ? '可用' : '不可用'}`
        ];

        console.log('XLang诊断报告:\n' + report.join('\n'));
        vscode.window.showInformationMessage('XLang诊断报告已生成，请查看控制台');

        // 尝试将文件设置为XLang类型
        if (document.languageId !== 'xlang') {
            vscode.window.showInformationMessage('当前文件不是XLang类型，尝试设置...');
            vscode.languages.setTextDocumentLanguage(document, 'xlang')
                .then(() => {
                    vscode.window.showInformationMessage('成功设置为XLang类型');
                })
                .catch(err => {
                    vscode.window.showErrorMessage(`设置失败: ${err.message}`);
                });
        }

        // 如果LSP客户端已启动，尝试发送测试通知
        if (langClient) {
            // 发送测试通知
            langClient.sendNotification('textDocument/didChange', {
                textDocument: {
                    uri: document.uri.toString(),
                    version: document.version
                },
                contentChanges: [{ text: document.getText() }]
            });
            console.log('已发送测试通知到LSP服务器');
            
            // 手动请求语义令牌
            langClient.sendRequest('textDocument/semanticTokens/full', {
                textDocument: {
                    uri: document.uri.toString()
                }
            }).then(tokens => {
                console.log('收到语义令牌:', tokens ? '有数据' : '无数据');
                if (tokens) {
                    console.log('令牌数据前100项:', JSON.stringify(tokens).substring(0, 500) + '...');
                }
            }).catch(err => {
                console.error('请求语义令牌失败:', err);
            });
        }

        // 如果LSP客户端已启动，尝试手动触发自动补全功能测试
        if (langClient && langClient.initializeResult && 
            langClient.initializeResult.capabilities.completionProvider) {
            console.log('自动补全功能已配置，可以使用补全提示');
            vscode.window.showInformationMessage('自动补全功能已启用，请尝试在编辑器中输入触发字符');
        } else if (langClient) {
            console.log('LSP服务器未提供自动补全功能');
            vscode.window.showWarningMessage('LSP服务器未提供自动补全功能，请检查服务器实现');
        }
    });

    // 添加手动触发自动补全命令
    let completionDisposable = vscode.commands.registerCommand('xlang.triggerCompletion', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'xlang') {
            vscode.window.showInformationMessage('请在XLang文件中使用此命令');
            return;
        }
        
        // 使用自定义方法直接向LSP发送补全请求
        await requestCompletionFromLSP(editor.document, editor.selection.active);
        console.log('手动向LSP服务器发送了补全请求');
    });
    
    // 监听文本编辑事件，以便在用户输入后自动触发补全
    const typingCompletionDisposable = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId === 'xlang' && 
            event.contentChanges.length > 0 && 
            event.contentChanges[0].text.length > 0) {
            
            // 获取当前活动编辑器
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === event.document) {
                // 延迟触发以避免频繁触发
                setTimeout(() => {
                    // 使用LSP请求获取补全
                    requestCompletionFromLSP(event.document, editor.selection.active);
                }, 100);
            }
        }
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
                console.log('检测到 XLang 文件变更，发送全量更新到 LSP 服务器');

                // 发送完整文档内容而不是增量变更
                langClient.sendNotification('textDocument/didChange', {
                    textDocument: {
                        uri: event.document.uri.toString(),
                        version: event.document.version
                    },
                    // 使用单个内容变更项，包含完整文档内容
                    contentChanges: [
                        {
                            text: event.document.getText()
                        }
                    ]
                });
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

    // 添加文档打开监听器
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (document.languageId === 'xlang' && langClient) {
                console.log('XLang 文件已打开，通知 LSP 服务器');
                langClient.sendNotification('textDocument/didOpen', {
                    textDocument: {
                        uri: document.uri.toString(),
                        languageId: document.languageId,
                        version: document.version,
                        text: document.getText()
                    },
                });
            }
        })
    );

    // 添加文档关闭监听器
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (document.languageId === 'xlang' && langClient) {
                console.log('XLang 文件已关闭，通知 LSP 服务器');
                langClient.sendNotification('textDocument/didClose', {
                    textDocument: {
                        uri: document.uri.toString()
                    }
                });
            }
        })
    );

    context.subscriptions.push(disposable);
    context.subscriptions.push(testDisposable);
    context.subscriptions.push(completionDisposable);
    context.subscriptions.push(typingCompletionDisposable);
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

    // 定义初始TCP端口，可以是随机生成的或配置的固定端口
    let initialPort = config.get('lspPort') || 9257; // 默认9257端口，可通过配置修改

    // 自动查找可用端口
    findAvailablePort(initialPort)
        .then(availablePort => {
            console.log(`LSP将使用端口: ${availablePort}`);
            startActualLSP(context, runtimePath, availablePort);
        })
        .catch(err => {
            const msg = `无法找到可用端口: ${err.message}`;
            vscode.window.showErrorMessage(msg);
            console.error(msg);
        });
}

/**
 * 查找可用端口
 * @param {number} startPort 起始端口
 * @param {number} maxAttempts 最大尝试次数
 * @returns {Promise<number>} 可用端口
 */
function findAvailablePort(startPort, maxAttempts = 10) {
    return new Promise((resolve, reject) => {
        let currentPort = startPort;
        let attempts = 0;

        function tryPort(port) {
            if (attempts >= maxAttempts) {
                reject(new Error(`在尝试${maxAttempts}个端口后仍未找到可用端口`));
                return;
            }

            attempts++;
            const server = net.createServer();

            server.once('error', err => {
                if (err.code === 'EADDRINUSE') {
                    console.log(`端口 ${port} 已被占用，尝试下一个端口...`);
                    tryPort(port + 1);
                } else {
                    reject(err);
                }
            });

            server.once('listening', () => {
                server.close(() => {
                    resolve(port);
                });
            });

            server.listen(port);
        }

        tryPort(currentPort);
    });
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
        // 增强的自动补全功能
        middleware: {
            provideCompletionItem: (document, position, context, token, next) => {

            },
            // 添加内联补全支持
            provideInlineCompletionItems: async (document, position, context, token, next) => {
                // 如果原始中间件链支持内联补全，则继续
                if (next) {
                    return next(document, position, context, token);
                }
                return null;
            }
        },
        // 配置功能支持
        capabilities: {
            // 明确声明支持自动补全，并减少触发限制
            completionProvider: {
                resolveProvider: true,
                // 几乎所有常用字符都可触发补全
                triggerCharacters: [
                    '.', ':', '@', '#', '(',
                    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
                    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
                    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
                    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
                    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
                    '_', '-', '+', '*', '/', '<', '>', '='
                ],
                allCommitCharacters: [' ', '\t', '\n', '(', ')', '[', ']', '{', '}', '.', ',', ';', ':']
            },
            // 支持内联补全功能
            inlineCompletionProvider: true,
            // 添加语义着色支持
            semanticTokensProvider: {
                full: true,
                range: false
            }
        },
        outputChannelName: 'XLang Language Server',
        revealOutputChannelOn: 1
    };
    try {
        // 创建语言客户端
        langClient = new LanguageClient('xlangLanguageServer', 'XLang Language Server', serverOptions, clientOptions);

        // 在启动前，先注册语义令牌类型和修饰符
        // 定义语义令牌类型（按照LSP规范）
        const tokenTypes = [
            'namespace', 'type', 'class', 'enum', 'interface',
            'struct', 'typeParameter', 'parameter', 'variable', 'property',
            'enumMember', 'event', 'function', 'method', 'macro',
            'keyword', 'modifier', 'comment', 'string', 'number',
            'regexp', 'operator', 'decorator',
            // XLang自定义语义令牌类型
            'null', 'boolean', 'base64', 'let', 'body',
            'boundary', 'assign', 'lambdaDef', 'expressions', 'lambdaCall',
            'asyncLambdaCall', 'operation', 'tuple', 'assumeTuple', 'keyValue',
            'indexOf', 'getAttr', 'return', 'raise', 'if',
            'while', 'namedTo', 'break', 'continue', 'range',
            'in', 'yield', 'alias', 'set', 'map'
        ];
        
        // 定义语义令牌修饰符
        const tokenModifiers = [
            'declaration', 'definition', 'readonly', 'static',
            'deprecated', 'abstract', 'async', 'modification',
            'documentation', 'defaultLibrary'
        ];
        
  
        // 注册语义令牌信息
        const legend = {
            tokenTypes,
            tokenModifiers
        };

        langClient.clientOptions.capabilities = langClient.clientOptions.capabilities || {};
        langClient.clientOptions.capabilities.textDocument = {
            ...(langClient.clientOptions.capabilities.textDocument || {}),
            semanticTokens: {
                dynamicRegistration: true,
                tokenTypes: tokenTypes,
                tokenModifiers: tokenModifiers,
                formats: ['relative'],
                requests: {
                    full: {
                        delta: false
                    },
                    range: false
                }
            }
        };
        
        // 添加语义令牌处理中间件
        langClient.clientOptions.middleware = {
            ...(langClient.clientOptions.middleware || {}),
            // 处理语义令牌的请求和响应
            workspace: {
                ...(langClient.clientOptions.middleware?.workspace || {}),
                // 拦截和处理语义令牌响应
                handleWorkspaceSymbol: (params, token, next) => {
                    console.log('拦截到工作区符号请求:', JSON.stringify(params));
                    return next(params, token);
                }
            },
            // 文档操作中间件
            textDocument: {
                ...(langClient.clientOptions.middleware?.textDocument || {}),
                // 处理语义令牌响应
                semanticTokens: {
                    ...(langClient.clientOptions.middleware?.textDocument?.semanticTokens || {}),
                    full: (document, token, next) => {
                        console.log(`请求文档的语义令牌: ${document.uri}`);
                        
                        // 先检查服务器是否支持语义令牌
                        if (!langClient.initializeResult?.capabilities?.semanticTokensProvider) {
                            console.log('服务器不支持语义令牌功能，跳过请求');
                            // 返回空令牌数据
                            return Promise.resolve({ data: [] });
                        }
                        
                        return next(document, token).then(tokens => {
                            if (tokens) {
                                console.log(`收到语义令牌数据，数据长度: ${tokens.data ? tokens.data.length : '未知'}`);
                                if (tokens.data && tokens.data.length > 0) {
                                    console.log(`令牌数据示例: [${tokens.data.slice(0, 10).join(', ')}]...`);
                                }
                            } else {
                                console.log('未收到语义令牌数据');
                                // 不再自动尝试手动请求，因为服务器可能不支持
                            }
                            return tokens;
                        });
                    }
                }
            }
        };
        
        // 注册语义令牌提供器到服务器初始化选项
        langClient.registerProposedFeatures();
        const initOptions = langClient.initializeParams?.initializationOptions || {};
        langClient.initializeParams = {
            ...langClient.initializeParams,
            initializationOptions: {
                ...initOptions,
                semanticTokens: {
                    legend: legend
                }
            }
        };

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

        // 添加自定义通知处理器，获取更多日志信息
        langClient.onNotification('window/logMessage', (params) => {
            console.log(`LSP日志: [${params.type}] ${params.message}`);
        });

        // 添加原始响应数据跟踪
        langClient.onRequest('textDocument/completion', (params, token) => {
            console.log('拦截到补全请求:', JSON.stringify(params));
            // 不处理请求，返回undefined让常规处理继续
            return undefined;
        });

    } catch (err) {
        console.error('创建LSP客户端时出错:', err);
        vscode.window.showErrorMessage(`无法启动XLang语言服务: ${err.message}`);
    }
}

/**
 * 将XLang的补全类型转换为VSCode的补全类型
 * @param {string} kind 补全类型名称
 * @returns {number} VSCode补全类型
 */
function translateCompletionKind(kind) {
    const CompletionItemKind = {
        Text: 1,
        Method: 2,
        Function: 3,
        Constructor: 4,
        Field: 5,
        Variable: 6,
        Class: 7,
        Interface: 8,
        Module: 9,
        Property: 10,
        Unit: 11,
        Value: 12,
        Enum: 13,
        Keyword: 14,
        Snippet: 15,
        Color: 16,
        File: 17,
        Reference: 18,
        Folder: 19,
        EnumMember: 20,
        Constant: 21,
        Struct: 22,
        Event: 23,
        Operator: 24,
        TypeParameter: 25
    };

    // 将字符串类型转换为数字类型
    if (typeof kind === 'string') {
        return CompletionItemKind[kind] || CompletionItemKind.Text;
    }
    
    // 已经是数字则直接返回
    if (typeof kind === 'number' && kind >= 1 && kind <= 25) {
        return kind;
    }
    
    // 默认类型
    return CompletionItemKind.Text;
}

/**
 * 直接向LSP服务器发送补全请求
 * @param {vscode.TextDocument} document 当前文档
 * @param {vscode.Position} position 光标位置
 */
async function requestCompletionFromLSP(document, position) {
    if (!langClient) {
        console.log('LSP客户端未初始化，无法请求补全');
        return;
    }

    try {
        console.log(`向LSP发送补全请求，位置: ${position.line}:${position.character}`);
        
        const params = {
            textDocument: {
                uri: document.uri.toString()
            },
            position: {
                line: position.line,
                character: position.character
            },
            context: {
                triggerKind: "Invoked",
            }
        };

        // 记录发送的补全请求参数以便调试
        console.log('发送的补全请求参数:', JSON.stringify(params));

        // 向LSP服务器发送补全请求
        langClient.sendRequest('textDocument/completion', params)
            .then(completionList => {
                if (completionList) {
                    const itemCount = Array.isArray(completionList) 
                        ? completionList.length 
                        : (completionList.items ? completionList.items.length : 0);
                    
                    console.log(`收到来自LSP的补全建议: ${itemCount} 项`);
                    
                    // 详细记录收到的建议，帮助调试
                    if (itemCount > 0) {
                        const items = Array.isArray(completionList) 
                            ? completionList 
                            : completionList.items;
                        
                        if (items && items.length > 0) {
                            console.log(`补全建议示例: ${JSON.stringify(items.slice(0, 3))}`);
                        }
                        
                        // 触发VSCode原生补全UI显示
                        vscode.commands.executeCommand('editor.action.triggerSuggest');
                    }
                } else {
                    console.log('LSP服务器未返回补全建议');
                }
            })
            .catch(error => {
                console.error('获取补全时出错:', error);
                // 记录更详细的错误信息
                if (error.message) {
                    console.error('错误消息:', error.message);
                }
                if (error.code) {
                    console.error('错误代码:', error.code);
                }
            });
    } catch (error) {
        console.error('发送补全请求时出错:', error);
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