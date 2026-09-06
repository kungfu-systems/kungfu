// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

function evaluateCall(node, context, seen) {
  const callee = node.expression.getText(context.tree);
  const args = [...(node.arguments || [])].map((arg) =>
    evaluate(arg, context, seen),
  );
  if (args.some((arg) => arg === null)) return null;
  // Never execute source. Only these path operations can produce a constant.
  try {
    if (['path.join', 'join'].includes(callee)) return path.join(...args);
    if (['path.resolve', 'resolve'].includes(callee))
      return path.resolve(...args);
    if (['path.dirname', 'dirname'].includes(callee))
      return path.dirname(args[0]);
    if (callee === 'fileURLToPath') return fileURLToPath(args[0]);
    if (callee === 'pathToFileURL') return pathToFileURL(args[0]).href;
    if (callee === 'URL') return new URL(...args).href;
  } catch {
    return null;
  }
  return null;
}

function evaluateTemplate(node, context, seen) {
  let value = node.head.text;
  for (const span of node.templateSpans) {
    const part = evaluate(span.expression, context, seen);
    if (part === null) return null;
    value += part + span.literal.text;
  }
  return value;
}

function evaluateCompound(node, context, seen) {
  if (ts.isParenthesizedExpression(node))
    return evaluate(node.expression, context, seen);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluate(node.left, context, seen);
    const right = evaluate(node.right, context, seen);
    return left !== null && right !== null ? left + right : null;
  }
  if (ts.isTemplateExpression(node))
    return evaluateTemplate(node, context, seen);
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'href')
    return evaluate(node.expression, context, seen);
  if (ts.isCallExpression(node) || ts.isNewExpression(node))
    return evaluateCall(node, context, seen);
  return null;
}

function evaluate(node, context, seen = new Set()) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  const expression = node.getText(context.tree);
  if (expression === 'import.meta.url')
    return pathToFileURL(context.filename).href;
  if (expression === '__dirname' || expression === 'import.meta.dirname')
    return path.dirname(context.filename);
  if (expression === '__filename' || expression === 'import.meta.filename')
    return context.filename;
  if (
    ts.isIdentifier(node) &&
    context.bindings.has(node.text) &&
    !seen.has(node.text)
  ) {
    return evaluate(
      context.bindings.get(node.text),
      context,
      new Set([...seen, node.text]),
    );
  }
  return evaluateCompound(node, context, seen);
}

function discover(node, context) {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer
  ) {
    if (node.parent.flags & ts.NodeFlags.Const) {
      // Ambiguous shadowed names stay unknown instead of choosing a binding.
      context.bindings.set(
        node.name.text,
        context.bindings.has(node.name.text) ? undefined : node.initializer,
      );
    }
    if (
      ts.isCallExpression(node.initializer) &&
      /(?:^|\.)createRequire$/u.test(
        node.initializer.expression.getText(context.tree),
      )
    ) {
      context.requires.add(node.name.text);
    }
  }
  ts.forEachChild(node, (child) => discover(child, context));
}

function add(node, context, kind = 'module') {
  const specifier = evaluate(node, context);
  if (specifier !== null)
    context.references.push({
      specifier,
      kind,
      line:
        context.tree.getLineAndCharacterOfPosition(node.getStart(context.tree))
          .line + 1,
    });
}

function configurationEntries(node, context, kind) {
  if (ts.isPropertyAssignment(node)) {
    configurationEntries(node.initializer, context, kind);
    return;
  }
  if (evaluate(node, context) !== null) add(node, context, kind);
  else
    ts.forEachChild(node, (child) =>
      configurationEntries(child, context, kind),
    );
}

function inspectConfiguration(node, context) {
  if (!ts.isPropertyAssignment(node)) return;
  const property = node.name.getText(context.tree).replace(/['"]/gu, '');
  if (property === 'alias')
    configurationEntries(node.initializer, context, 'alias');
  if (property === 'entryPoints')
    configurationEntries(node.initializer, context, 'build-entry');
}

function inspectCall(node, context) {
  if (ts.isCallExpression(node) && node.arguments[0]) {
    const callee = node.expression.getText(context.tree);
    if (
      callee === 'import' ||
      context.requires.has(callee.replace(/\.resolve$/u, '')) ||
      callee === 'import.meta.resolve'
    )
      add(node.arguments[0], context);
  }
  if (
    ts.isNewExpression(node) &&
    node.expression.getText(context.tree) === 'URL' &&
    node.arguments?.[1]?.getText(context.tree) === 'import.meta.url'
  ) {
    add(node.arguments[0], context, 'url');
  }
}

function visit(node, context) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier
  )
    add(node.moduleSpecifier, context);
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression
  )
    add(node.moduleReference.expression, context);
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    add(node.argument.literal, context);
  inspectCall(node, context);
  inspectConfiguration(node, context);
  ts.forEachChild(node, (child) => visit(child, context));
}

export function moduleReferences(source, filename) {
  const context = {
    tree: ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true),
    filename: path.resolve(filename),
    bindings: new Map(),
    requires: new Set(['require']),
    references: [],
  };
  discover(context.tree, context);
  visit(context.tree, context);
  return context.references;
}
