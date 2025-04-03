/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from "vscode";
import * as fs from "graceful-fs"; // using graceful-fs to avoid EMFILE errors
import * as nodepath from "path";
import * as babel from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import { ImportDeclaration, Directive, File } from "@babel/types";

const isClientComponentCache: Record<string, boolean> = {};
const checkingStack: string[] = [];
const projectRootsCache: string[] = [];

function getProjectRoots(): string[] {
    const config = vscode.workspace.getConfiguration('nextJsAppRouterHelper');
    const configuredRoots = config.get<string[]>('projectRoots') || [];
    
    if (configuredRoots.length > 0) {
        return configuredRoots;
    }
    
    if (!vscode?.workspace?.workspaceFolders?.length) {
        throw new Error('No workspace folder found');
    }
    
    // By default, use the first workspace folder like in the original implementation
    return [vscode.workspace.workspaceFolders[0].uri.fsPath];
}

function getTsConfigPathAliases(projectRoot: string): Record<string, string> {
    const tsConfigPath = nodepath.join(projectRoot, "tsconfig.json");
    try {
        const tsConfigContents = fs.readFileSync(tsConfigPath, "utf-8");
        const tsConfig = JSON.parse(tsConfigContents);
        const baseUrl = tsConfig?.compilerOptions?.baseUrl || ".";
        const paths = tsConfig?.compilerOptions?.paths || {};

        const aliases: Record<string, string> = {};
        for (const alias in paths) {
            aliases[alias] = nodepath.resolve(
                projectRoot,
                baseUrl,
                paths[alias][0]
            );
        }

        return aliases;
    } catch (error) {
        console.error("Could not read tsconfig.json", error);
        return {};
    }
}

//check all components in the project
async function scanProjectForClientComponents(folderPath: string, aliases: Record<string, string>): Promise<void> {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });

    for (const entry of entries) {
        try {
            const fullEntryPath = nodepath.join(folderPath, entry.name);
            if (fullEntryPath.includes(`/pages/`)) {
                continue;
            }

            if (entry.isDirectory()) {
                await scanProjectForClientComponents(fullEntryPath, aliases);
            } else if (entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".jsx"))) {
                await isClientComponent(fullEntryPath, aliases);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error while scanning ${entry.name}: ${error}`);
        }
    }
}

//check for client directive in component
async function isClientComponent(filePath: string, aliases: Record<string, string>): Promise<boolean> {
    //mark component and all its imports as client components
    async function markComponentAsClient(filePath: string, astProp?: babel.ParseResult<File>) {
        if (checkingStack.includes(filePath)) {
            return;
        }

        if (!checkingStack.includes(filePath)) {
            checkingStack.push(filePath);
            isClientComponentCache[filePath] = true;
        }

        let ast;

        if (!astProp) {
            const code = fs.readFileSync(filePath, "utf-8");
            ast = babel.parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
        } else {
            ast = astProp;
        }

        traverse(ast, {
            ImportDeclaration(path: NodePath<ImportDeclaration>) {
                if (path.node.importKind === "type") {
                    return; // Skip over TypeScript type imports
                }

                let source = path.node.source.value;

                if (source.startsWith(".")) {
                    const fullSourcePath = nodepath.resolve(nodepath.dirname(filePath), source) + ".tsx";
                    markComponentAsClient(fullSourcePath);
                }

                if (source.startsWith("/")) {
                    const fullSourcePath = nodepath.resolve(nodepath.dirname(filePath), source) + ".tsx";
                    markComponentAsClient(fullSourcePath);
                }

                for (const alias in aliases) {
                    // check if import is using an alias from tsconfig.json
                    const test = alias.replace(/\/\*/, ""); // some fun regex things to remove the * from the end of the alias
                    if (source.startsWith(alias.replace(/\/\*/, ""))) {
                        const newSource = source.replace(alias.replace(/\/\*/, ""), aliases[alias].replace("*", ""));
                        const fullSourcePath = nodepath.resolve(nodepath.dirname(filePath), newSource) + ".tsx";
                        markComponentAsClient(fullSourcePath);
                        break;
                    }
                }
            },
        });

        checkingStack.splice(checkingStack.indexOf(filePath), 1);
    }

    if (filePath in isClientComponentCache) {
        return isClientComponentCache[filePath];
    }

    const code = await fs.promises.readFile(filePath, "utf-8");
    const ast = babel.parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });

    let containsClientDirective = false;

    traverse(ast, {
        Directive(path: NodePath<Directive>) {
            const directive = path.node.value.value;
            if (directive === "use client") {
                containsClientDirective = true;
                path.stop();
            }
        },
    });

    if (containsClientDirective) {
        markComponentAsClient(filePath, ast);
    } else {
        isClientComponentCache[filePath] = false;
    }

    return isClientComponentCache[filePath];
}

function checkIfNextProject(projectRoot: string): boolean {
    try {
        const packageJson = JSON.parse(fs.readFileSync(nodepath.join(projectRoot, "package.json")).toString());
        const nextVersion = packageJson.dependencies?.next || packageJson.devDependencies?.next;

        if (!nextVersion) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    if (!vscode?.workspace?.workspaceFolders?.length) {
        return;
    }

    const projectRoots = getProjectRoots();
    const validNextProjects = projectRoots.filter(checkIfNextProject);

    if (validNextProjects.length === 0) {
        vscode.window.showErrorMessage("No valid Next.js projects found in the configured roots");
        return;
    }

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    statusBarItem.text = "Scanning projects for client components...";

    const updateStatusBarItem = (editor: vscode.TextEditor | undefined) => {
        if (editor) {
            const filePath = editor.document.fileName;
            if (filePath in isClientComponentCache) {
                const componentType = isClientComponentCache[filePath] ? "Client" : "Server";
                statusBarItem.text = `${componentType} Component`;
                statusBarItem.command = "extension.scan";
                statusBarItem.show();
            } else {
                statusBarItem.text = "Not a component";
            }
        }
    };

    // Scan each project root
    for (const projectRoot of validNextProjects) {
        const aliases = getTsConfigPathAliases(projectRoot);
        await scanProjectForClientComponents(projectRoot, aliases);
    }

    vscode.window.showInformationMessage("Scan complete!");
    updateStatusBarItem(vscode.window.activeTextEditor);

    context.subscriptions.push(
        vscode.commands.registerCommand("extension.scan", async () => {
            // Clear cache before rescanning
            Object.keys(isClientComponentCache).forEach(key => delete isClientComponentCache[key]);
            checkingStack.length = 0;

            // Scan each project root
            for (const projectRoot of validNextProjects) {
                const aliases = getTsConfigPathAliases(projectRoot);
                await scanProjectForClientComponents(projectRoot, aliases);
            }

            vscode.window.showInformationMessage("Scan complete!");
            updateStatusBarItem(vscode.window.activeTextEditor);
        })
    );

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarItem));
}

export function deactivate() {}
