// actual/catch-must-report — pm/error_err.mdx §12.1.
//
// Every place a failure is caught must either report it to the error file, hand it to a reporting
// net, rethrow it, or mark it expected. A catch that only logs (or does nothing) is the silent
// failure the error file exists to end. Two companion checks keep the records useful: the `where`
// given to errorFileFor() must be this file's repo-relative path, and the `doing` given to a report
// must be a stable string so burst folding (§10.1) has a key.

const fs = require('fs');
const path = require('path');

/** Methods on an ErrorFile object (§5). */
const REPORT_METHODS = new Set([
  'caught',
  'warn',
  'expected',
  'rethrow',
  'fatal',
]);

/** Free functions that report on the caller's behalf (§5, §6.11). */
const REPORT_HELPERS = new Set([
  'tryOr',
  'tryOrAsync',
  'reportRejection',
  'guard',
  'reportBoundaryError',
  'captureException',
  'reportError',
  'showBoundary',
  'logError',
]);

/** Helpers whose `doing` is the second argument (`fn(errors, doing, …)`). */
const DOING_SECOND_ARG_HELPERS = new Set([
  'tryOr',
  'tryOrAsync',
  'reportRejection',
  'guard',
  'reportBoundaryError',
]);

/** Identifiers (or trailing member names) allowed inside a `doing` template literal (§12.1). */
const DOING_IDENTIFIERS = new Set(['name', 'method', 'path', 'route']);

const ROOT_MARKERS = ['yarn.lock', 'lage.config.js'];

/** Keys of an AST node that are never children. */
const NON_CHILD_KEYS = new Set([
  'parent',
  'loc',
  'range',
  'start',
  'end',
  'type',
  'tokens',
  'comments',
]);

function isErrorFileIdentifier(node) {
  return (
    node &&
    node.type === 'Identifier' &&
    (node.name === 'errors' || node.name.endsWith('Errors'))
  );
}

function isIdentifierNamed(node, name) {
  return node && node.type === 'Identifier' && node.name === name;
}

/** The plain property name of a non-computed member access, else null. */
function memberPropertyName(node) {
  if (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier'
  ) {
    return node.property.name;
  }
  return null;
}

function isFunctionNode(node) {
  return (
    node &&
    (node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression')
  );
}

function isStringLiteral(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string';
}

/** True when `node` is a call that counts as reporting, rethrowing or handing off (§12.1). */
function isReportingCall(node) {
  if (node.type !== 'CallExpression') return false;
  const { callee } = node;

  if (callee.type === 'MemberExpression') {
    const prop = memberPropertyName(callee);
    if (prop === null) return false;
    if (REPORT_METHODS.has(prop) && isErrorFileIdentifier(callee.object)) {
      return true;
    }
    return REPORT_HELPERS.has(prop) || prop.endsWith('OrThrow');
  }

  if (callee.type === 'Identifier') {
    return REPORT_HELPERS.has(callee.name) || callee.name.endsWith('OrThrow');
  }

  return false;
}

/** `Promise.reject(...)` */
function isPromiseReject(node) {
  return (
    node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    isIdentifierNamed(node.callee.object, 'Promise') &&
    memberPropertyName(node.callee) === 'reject'
  );
}

/** Walk a subtree (any depth) and return true as soon as `pred` matches a node. */
function subtreeSome(root, pred) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (typeof node.type !== 'string') continue;
    if (pred(node)) return true;
    for (const key of Object.keys(node)) {
      if (NON_CHILD_KEYS.has(key)) continue;
      const child = node[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

function nodePasses(node) {
  if (node.type === 'ThrowStatement') return true;
  if (node.type === 'ReturnStatement' && isPromiseReject(node.argument)) {
    return true;
  }
  return isReportingCall(node);
}

/**
 * Does a handler body report? `body` is a BlockStatement, or the expression of an
 * expression-bodied arrow (which is an implicit return).
 */
function handlerReports(body) {
  if (!body) return false;
  if (body.type !== 'BlockStatement' && isPromiseReject(body)) return true;
  return subtreeSome(body, nodePasses);
}

function isEmptyBlock(body) {
  return body && body.type === 'BlockStatement' && body.body.length === 0;
}

/** `def.method`, `def.path`, `def.a.b` — a member chain rooted at `def`. */
function isDefChain(node) {
  let cur = node;
  while (cur.type === 'MemberExpression' && !cur.computed) cur = cur.object;
  return isIdentifierNamed(cur, 'def') && cur !== node;
}

function isActionType(node) {
  return (
    node.type === 'MemberExpression' &&
    isIdentifierNamed(node.object, 'action') &&
    memberPropertyName(node) === 'type'
  );
}

function isRouteOfReq(node) {
  return (
    node.type === 'CallExpression' &&
    isIdentifierNamed(node.callee, 'routeOf') &&
    node.arguments.length === 1 &&
    isIdentifierNamed(node.arguments[0], 'req')
  );
}

/** `req.method`, `this.name`, `route.path` — a non-computed chain ending in an allowed name. */
function isAllowedMemberChain(node) {
  if (node.type !== 'MemberExpression') return false;
  const last = memberPropertyName(node);
  if (last === null || !DOING_IDENTIFIERS.has(last)) return false;
  let cur = node.object;
  while (cur.type === 'MemberExpression' && !cur.computed) cur = cur.object;
  return cur.type === 'Identifier' || cur.type === 'ThisExpression';
}

function isAllowedDoingExpression(expr) {
  if (expr.type === 'Identifier') return DOING_IDENTIFIERS.has(expr.name);
  return (
    isAllowedMemberChain(expr) ||
    isDefChain(expr) ||
    isActionType(expr) ||
    isRouteOfReq(expr)
  );
}

function isStableDoing(node) {
  if (!node) return false;
  if (isStringLiteral(node)) return true;
  if (node.type === 'TemplateLiteral') {
    return node.expressions.every(isAllowedDoingExpression);
  }
  return false;
}

/** The `doing` argument of a reporting call, or undefined when the call has none. */
function doingArgument(node) {
  const { callee } = node;
  if (callee.type === 'MemberExpression') {
    if (
      REPORT_METHODS.has(memberPropertyName(callee)) &&
      isErrorFileIdentifier(callee.object)
    ) {
      return node.arguments[0];
    }
    return undefined;
  }
  if (
    callee.type === 'Identifier' &&
    DOING_SECOND_ARG_HELPERS.has(callee.name) &&
    isErrorFileIdentifier(node.arguments[0])
  ) {
    return node.arguments[1];
  }
  return undefined;
}

function findRepoRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (ROOT_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The `where` this file must pass to errorFileFor(): its repo-relative path with a leading
 * `packages/` removed (§5). Returns null when the file has no usable path (stdin, virtual).
 */
function expectedWhere(filename) {
  if (!filename || filename.startsWith('<')) return null;
  let rel = filename.replace(/\\/g, '/');
  if (path.isAbsolute(filename)) {
    const root = findRepoRoot(path.dirname(filename));
    if (root) {
      rel = path.relative(root, filename).replace(/\\/g, '/');
    } else {
      const idx = rel.indexOf('/packages/');
      if (idx === -1) return null;
      rel = rel.slice(idx + 1);
    }
  }
  rel = rel.replace(/^(\.\/)+/, '');
  if (rel.startsWith('..')) return null;
  return rel.startsWith('packages/') ? rel.slice('packages/'.length) : rel;
}

/** JSX element name as text: `ErrorBoundary`, `Foo.ErrorBoundary`. */
function jsxNameText(nameNode) {
  if (!nameNode) return '';
  if (nameNode.type === 'JSXIdentifier') return nameNode.name;
  if (nameNode.type === 'JSXMemberExpression') {
    return `${jsxNameText(nameNode.object)}.${nameNode.property.name}`;
  }
  return '';
}

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every catch, .catch(), ErrorBoundary onError and error listener must report to the error file, rethrow, or mark the failure expected (pm/error_err.mdx §6, §12.1)',
    },
    fixable: 'code',
    schema: [],
    messages: {
      unreported:
        'This catch neither reports, rethrows, nor marks the failure expected — see pm/error_err.mdx §6',
      emptyCatch:
        'Empty catch swallows the failure — call errors.expected(…) if it is expected, otherwise errors.caught(…) — see pm/error_err.mdx §6 Pattern 3',
      wrongWhere:
        "errorFileFor() must be given this file's repo-relative path '{{expected}}' — see pm/error_err.mdx §5",
      dynamicDoing:
        'The `doing` argument must be a string literal (or a template whose only expressions are name, method, path, route, def.*, action.type or routeOf(req)) so the fold key stays stable — see pm/error_err.mdx §5',
    },
  },

  createOnce(context) {
    let expected = null;

    function reportHandler(site, body) {
      if (isEmptyBlock(body)) {
        context.report({ node: site, messageId: 'emptyCatch' });
      } else if (!handlerReports(body)) {
        context.report({ node: site, messageId: 'unreported' });
      }
    }

    /** Check an inline function handler; other shapes (a named handler) are opaque and pass. */
    function checkHandlerArgument(site, handler) {
      if (!handler) return;
      if (isFunctionNode(handler)) {
        reportHandler(site, handler.body);
        return;
      }
      // `.catch(console.error)` is the console-only report Pattern 5 replaces.
      if (
        handler.type === 'MemberExpression' &&
        isIdentifierNamed(handler.object, 'console')
      ) {
        context.report({ node: site, messageId: 'unreported' });
      }
    }

    function checkWhere(node) {
      if (expected === null) return;
      const arg = node.arguments[0];
      if (isStringLiteral(arg) && arg.value === expected) return;
      context.report({
        node: arg || node,
        messageId: 'wrongWhere',
        data: { expected },
        fix(fixer) {
          const text = `'${expected}'`;
          return arg
            ? fixer.replaceText(arg, text)
            : fixer.replaceText(node, `errorFileFor(${text})`);
        },
      });
    }

    function checkDoing(node) {
      const doing = doingArgument(node);
      if (doing === undefined) return;
      if (!isStableDoing(doing)) {
        context.report({ node: doing, messageId: 'dynamicDoing' });
      }
    }

    return {
      before() {
        expected = expectedWhere(context.filename);
      },

      CatchClause(node) {
        reportHandler(node, node.body);
      },

      CallExpression(node) {
        const { callee } = node;

        if (isIdentifierNamed(callee, 'errorFileFor')) {
          checkWhere(node);
          return;
        }

        checkDoing(node);

        if (callee.type !== 'MemberExpression') return;
        const prop = memberPropertyName(callee);
        if (prop === 'catch') {
          checkHandlerArgument(node, node.arguments[0]);
        } else if (prop === 'then') {
          if (node.arguments.length >= 2) {
            checkHandlerArgument(node, node.arguments[1]);
          }
        } else if (
          prop === 'addEventListener' &&
          isStringLiteral(node.arguments[0]) &&
          node.arguments[0].value === 'error'
        ) {
          checkHandlerArgument(node, node.arguments[1]);
        }
      },

      JSXAttribute(node) {
        if (
          node.name.type !== 'JSXIdentifier' ||
          node.name.name !== 'onError'
        ) {
          return;
        }
        const element = node.parent;
        if (!element || element.type !== 'JSXOpeningElement') return;
        if (!jsxNameText(element.name).endsWith('ErrorBoundary')) return;
        const value = node.value;
        if (!value || value.type !== 'JSXExpressionContainer') return;
        const expr = value.expression;
        if (isFunctionNode(expr)) {
          reportHandler(node, expr.body);
        } else if (expr.type === 'CallExpression' && !isReportingCall(expr)) {
          context.report({ node, messageId: 'unreported' });
        }
      },
    };
  },
};
