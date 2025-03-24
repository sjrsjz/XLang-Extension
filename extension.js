const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 保存终端引用
let xlangTerminal = null;

/**
 * 激活扩展时被调用
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('XLang扩展已激活');

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

    context.subscriptions.push(disposable);
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
}

module.exports = {
    activate,
    deactivate
};