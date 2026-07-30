import { Project, Node, SyntaxKind } from 'ts-morph';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { logger } from './logger.js';

function resolveLocalPath(baseDir: string, moduleSpecifier: string): string | null {
  let cleanedSpecifier = moduleSpecifier;
  if (cleanedSpecifier.endsWith('.js')) {
    cleanedSpecifier = cleanedSpecifier.replace(/\.js$/, '');
  }

  const exts = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js', '/index.tsx', '/index.jsx'];
  const fullPath = resolve(baseDir, cleanedSpecifier);
  
  try {
    const exactPath = resolve(baseDir, moduleSpecifier);
    if (existsSync(exactPath) && statSync(exactPath).isFile()) {
      return exactPath;
    }
  } catch(e) {}
  
  for (const ext of exts) {
    const withExt = fullPath + ext;
    try {
      if (existsSync(withExt) && statSync(withExt).isFile()) {
         return withExt;
      }
    } catch(e) {}
  }
  return null;
}

export function scanDependencies(filePath: string, maxTokens = 2000): string {
  try {
    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(filePath);
    
    let context = '';
    const imports = sourceFile.getImportDeclarations();
    const baseDir = dirname(filePath);
    
    for (const imp of imports) {
      const moduleSpecifier = imp.getModuleSpecifierValue();
      
      // Skip node_modules or absolute built-in modules
      if (!moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/')) {
        continue;
      }
      
      const resolvedPath = resolveLocalPath(baseDir, moduleSpecifier);
      if (resolvedPath) {
        const content = readFileSync(resolvedPath, 'utf-8');
        context += `\n--- Related Context from ${moduleSpecifier} ---\n${content}\n`;
        
        if (context.length > maxTokens * 4) {
          context = context.substring(0, maxTokens * 4) + '\n... [Context Truncated due to size limits]';
          break;
        }
      }
    }
    
    // Look for prisma schema to provide type context
    const possiblePrismaPaths = [
      resolve(process.cwd(), 'prisma/schema.prisma'),
      resolve(process.cwd(), 'schema.prisma')
    ];
    for (const p of possiblePrismaPaths) {
      if (existsSync(p)) {
        const content = readFileSync(p, 'utf-8');
        context += `\n--- Prisma Schema Context ---\n${content}\n`;
        break; // Only include it once
      }
    }
    
    return context.trim();
  } catch (error: any) {
    logger.error(`Architecture Scanner failed for ${filePath}: ${error.message}`);
    return '';
  }
}

import fg from 'fast-glob';

export async function generateWorkspaceMap(): Promise<string> {
  try {
    const files = await fg([
      '**/*.{ts,js,tsx,jsx,json,prisma}',
      '!**/node_modules/**',
      '!**/dist/**',
      '!**/build/**',
      '!**/coverage/**'
    ], { cwd: process.cwd(), dot: true });
    
    let mapStr = files.join('\n');
    
    // Hard limit the string length to prevent OpenAI API TPM / Token limit crashes.
    // 5,000 characters is roughly ~1,250 tokens.
    if (mapStr.length > 5000) {
       mapStr = mapStr.substring(0, 5000) + '\n\n... [WORKSPACE MAP TRUNCATED DUE TO SIZE LIMIT].\nWARNING: The repository is too large to fit in this prompt. Use your `list_dir` tool to explore directories to find the exact file paths you need.';
    }
    
    return mapStr;
  } catch (error) {
    return '';
  }
}

export function scanExternalDependencies(filePath: string): string[] {
  try {
    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(filePath);
    
    const externalDeps = new Set<string>();
    const imports = sourceFile.getImportDeclarations();
    
    for (const imp of imports) {
      const moduleSpecifier = imp.getModuleSpecifierValue();
      
      // If it doesn't start with . or / it's likely an NPM package or built-in
      if (!moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/')) {
        // Strip out subpaths like 'stripe/lib/crypto' -> 'stripe'
        // But support scoped packages like '@aws-sdk/client-s3'
        let pkgName = moduleSpecifier;
        if (pkgName.startsWith('@')) {
           const parts = pkgName.split('/');
           if (parts.length >= 2) {
             pkgName = `${parts[0]}/${parts[1]}`;
           }
        } else {
           pkgName = pkgName.split('/')[0];
        }
        
        // Skip common node built-ins
        const builtIns = ['fs', 'path', 'crypto', 'child_process', 'util', 'os', 'http', 'https', 'events'];
        if (!builtIns.includes(pkgName)) {
           externalDeps.add(pkgName);
        }
      }
    }
    return Array.from(externalDeps);
  } catch (err) {
    return [];
  }
}

export function generateASTMap(filePath: string, testedFunctions: string[] = []): string {
  try {
    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(filePath);
    let output = '--- FILE STRUCTURE MAP ---\n';
    let itemCount = 0;
    const maxItems = 50;
    let skippedCount = 0;

    const formatLines = (node: any) => `(Lines ${node.getStartLineNumber()} - ${node.getEndLineNumber()})`;

    for (const func of sourceFile.getFunctions()) {
      if (itemCount >= maxItems) break;
      const name = func.getName() || 'anonymous';
      if (testedFunctions.includes(name)) {
        skippedCount++;
        continue;
      }
      output += `- Function: \`${name}\` ${formatLines(func)}\n`;
      itemCount++;
    }

    for (const cls of sourceFile.getClasses()) {
      if (itemCount >= maxItems) break;
      const name = cls.getName() || 'anonymous';
      if (testedFunctions.includes(name)) {
        skippedCount++;
        continue;
      }
      output += `- Class: \`${name}\` ${formatLines(cls)}\n`;
      itemCount++;
      for (const method of cls.getMethods()) {
         output += `  - Method: \`${method.getName()}\` ${formatLines(method)}\n`;
      }
    }

    for (const variable of sourceFile.getVariableStatements()) {
      if (itemCount >= maxItems) break;
      for (const dec of variable.getDeclarations()) {
         // Skip require() statements to avoid cluttering the map with imports
         if (dec.getInitializer()?.getText().startsWith('require(')) continue;
         
         const name = dec.getName();
         if (testedFunctions.includes(name)) {
           skippedCount++;
           continue;
         }
         output += `- Variable: \`${name}\` ${formatLines(dec)}\n`;
         itemCount++;
      }
    }
    
    for (const stmt of sourceFile.getStatements()) {
       if (itemCount >= maxItems) break;
       if (stmt.getKindName() === 'ExpressionStatement') {
          const expr = (stmt as any).getExpression();
          if (expr && expr.getKindName() === 'BinaryExpression') {
             const left = expr.getLeft().getText();
             if (left.startsWith('module.exports') || left.startsWith('exports.')) {
                const right = expr.getRight();
                if (right.getKindName() === 'ObjectLiteralExpression') {
                   for (const prop of right.getProperties()) {
                      if (itemCount >= maxItems) break;
                      let propName = 'unknown';
                      if (prop.getKindName() === 'PropertyAssignment' || prop.getKindName() === 'MethodDeclaration' || prop.getKindName() === 'ShorthandPropertyAssignment') {
                         propName = (prop as any).getName();
                      }
                      if (testedFunctions.includes(propName)) {
                        skippedCount++;
                        continue;
                      }
                      output += `- Exported Member: \`${propName}\` ${formatLines(prop)}\n`;
                      itemCount++;
                   }
                } else {
                   const name = left.replace('module.exports.', '').replace('exports.', '');
                   if (name && name !== 'module.exports') {
                      if (testedFunctions.includes(name)) {
                        skippedCount++;
                        continue;
                      }
                      output += `- Exported Member: \`${name}\` ${formatLines(stmt)}\n`;
                      itemCount++;
                   }
                }
             }
          }
       }
    }

    if (itemCount >= maxItems) {
       output += `\n... [MAP TRUNCATED: File exports over ${maxItems + skippedCount} items. (Skipped ${skippedCount} already tested items). Focus on the available ones first.]`;
    }

    if (itemCount === 0) {
       output += `No top-level functions, classes, or recognizable module.exports found. AI should rely on reading the file directly.\n`;
    }

    return output;
  } catch (error: any) {
  }
}

export function generateKnowledgeGraph(filePath: string, testedFunctions: string[] = [], maxItems: number = 10): string {
  try {
    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(filePath);
    
    const nodes = new Map<string, any>();
    const edges: any[] = [];
    
    let itemCount = 0;
    
    function addNode(id: string, type: string, file: string, exported: boolean = false, lineStart?: number, lineEnd?: number) {
      if (!nodes.has(id)) nodes.set(id, { id, type, file, exported, lineStart, lineEnd });
    }

    function addEdge(from: string, to: string, relation: string) {
      if (!edges.some(e => e.from === from && e.to === to && e.relation === relation)) {
          edges.push({ from, to, relation });
      }
    }
    
    function processNode(node: Node, currentId: string, depth: number) {
      if (depth > 2) return;
      
      const calls = node.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expr = call.getExpression();
        
        let symbol: any = null;
        try {
          symbol = expr.getSymbol();
        } catch (e) {
          // Ignore symbol resolution crashes on massive untyped JS files
        }

        
        let targetName = expr.getText();
        let targetFile = 'unknown';
        let type = 'external_dependency';
        
        if (symbol) {
          const decls = symbol.getDeclarations();
          if (decls && decls.length > 0) {
            const decl = decls[0];
            targetFile = decl.getSourceFile().getBaseName();
            targetName = symbol.getName();
            if (targetFile === sourceFile.getBaseName()) {
              type = 'internal_dependency';
            }
          }
        }
        
        if (targetName.length > 30) targetName = targetName.substring(0, 30) + '...';
        
        const targetId = `${targetFile}:${targetName}`;
        addNode(targetId, type, targetFile);
        addEdge(currentId, targetId, 'CALLS');
      }
    }

    for (const func of sourceFile.getFunctions()) {
      if (itemCount >= maxItems) break;
      const name = func.getName() || 'anonymous';
      if (!testedFunctions.some(t => t.includes(name))) {
         const id = `${sourceFile.getBaseName()}:${name}`;
         addNode(id, 'function', sourceFile.getBaseName(), func.isExported(), func.getStartLineNumber(), func.getEndLineNumber());
         processNode(func, id, 1);
         itemCount++;
      }
    }

    for (const cls of sourceFile.getClasses()) {
      for (const method of cls.getMethods()) {
          if (itemCount >= maxItems) break;
          const name = method.getName();
          if (!testedFunctions.some(t => t.includes(name))) {
              const id = `${sourceFile.getBaseName()}:${name}`;
              addNode(id, 'method', sourceFile.getBaseName(), cls.isExported(), method.getStartLineNumber(), method.getEndLineNumber());
              processNode(method, id, 1);
              itemCount++;
          }
      }
    }
    
    for (const variable of sourceFile.getVariableStatements()) {
      if (itemCount >= maxItems) break;
      for (const dec of variable.getDeclarations()) {
         if (dec.getInitializer()?.getText().startsWith('require(')) continue;
         const name = dec.getName();
         if (!testedFunctions.some(t => t.includes(name))) {
             const id = `${sourceFile.getBaseName()}:${name}`;
             addNode(id, 'variable', sourceFile.getBaseName(), variable.isExported(), dec.getStartLineNumber(), dec.getEndLineNumber());
             processNode(dec, id, 1);
             itemCount++;
         }
      }
    }
    
    for (const stmt of sourceFile.getStatements()) {
       if (itemCount >= maxItems) break;
       if (stmt.getKindName() === 'ExpressionStatement') {
          const expr = (stmt as any).getExpression();
          if (expr && expr.getKindName() === 'BinaryExpression') {
             const left = expr.getLeft().getText();
             if (left.startsWith('module.exports') || left.startsWith('exports.')) {
                const right = expr.getRight();
                if (right.getKindName() === 'ObjectLiteralExpression') {
                   for (const prop of right.getProperties()) {
                      if (itemCount >= maxItems) break;
                      let propName = 'unknown';
                      if (prop.getKindName() === 'PropertyAssignment' || prop.getKindName() === 'MethodDeclaration' || prop.getKindName() === 'ShorthandPropertyAssignment') {
                         propName = (prop as any).getName();
                      }
                      if (!testedFunctions.some(t => t.includes(propName))) {
                        const id = `${sourceFile.getBaseName()}:${propName}`;
                        addNode(id, 'exported_member', sourceFile.getBaseName(), true, prop.getStartLineNumber(), prop.getEndLineNumber());
                        processNode(prop, id, 1);
                        itemCount++;
                      }
                   }
                } else {
                   const name = left.replace('module.exports.', '').replace('exports.', '');
                   if (name && name !== 'module.exports') {
                      if (!testedFunctions.some(t => t.includes(name))) {
                        const id = `${sourceFile.getBaseName()}:${name}`;
                        addNode(id, 'exported_member', sourceFile.getBaseName(), true, stmt.getStartLineNumber(), stmt.getEndLineNumber());
                        processNode(stmt, id, 1);
                        itemCount++;
                      }
                   }
                }
             }
          }
       }
    }
    
    if (itemCount === 0) {
      return JSON.stringify({ error: "No untested functions or methods found." });
    }

    const result: any = {
      file: sourceFile.getBaseName(),
      nodes: Array.from(nodes.values()),
      edges
    };
    
    if (itemCount >= maxItems) {
      result.truncated = true;
      result.note = `There are more untested functions in this file. Only the first ${maxItems} are shown to save context. Test these first.`;
    }

    return JSON.stringify(result, null, 2);
  } catch (error: any) {
    return JSON.stringify({ error: `Failed to generate Knowledge Graph: ${error.message}` });
  }
}
