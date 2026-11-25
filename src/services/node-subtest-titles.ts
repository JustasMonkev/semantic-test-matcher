import { NodeWeakMap, type SyntaxNode, type Tree } from '@lezer/common';
import { parser } from '@lezer/javascript';

const script = parser.configure({ dialect: 'ts' });
const jsx = parser.configure({ dialect: 'ts jsx' });
const NODE_MODIFIERS = new Set(['only', 'skip', 'todo']);
const FUNCTION_SCOPES = new Set(['Script', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration', 'Property']);
const BLOCK_SCOPES = new Set(['Block', 'ForStatement', 'SwitchBody', 'CatchClause', 'ClassExpression']);

function spelling(node: SyntaxNode | null, text: string): string {
    return node ? text.slice(node.from, node.to) : '';
}

function literal(node: SyntaxNode | null, text: string): string {
    if (node?.name !== 'String' && node?.name !== 'TemplateString') return '';
    const raw = spelling(node, text);
    return raw.length >= 2 && raw[raw.length - 1] === raw[0] ? raw.slice(1, -1) : '';
}

function nextToken(node: SyntaxNode | null): SyntaxNode | null {
    let next = node?.nextSibling ?? null;
    while (next?.name === 'BlockComment' || next?.name === 'LineComment') next = next.nextSibling;
    return next;
}

// Keep the declaration itself: two identically spelled parameters are different receivers.
function bindingScopes(tree: Tree, text: string) {
    const scopes = new NodeWeakMap<Map<string, SyntaxNode>>();
    tree.iterate({ enter(ref) {
        if (ref.name !== 'VariableDefinition') return;
        const definition = ref.node;
        let owner = definition.parent;
        if (owner?.name === 'FunctionDeclaration') owner = owner.parent;
        let functionScoped = false;
        while (owner) {
            if (owner.name === 'VariableDeclaration') functionScoped = owner.firstChild?.name === 'var';
            if (FUNCTION_SCOPES.has(owner.name) || (!functionScoped && BLOCK_SCOPES.has(owner.name))) {
                const locals = scopes.get(owner) ?? new Map<string, SyntaxNode>();
                locals.set(spelling(definition, text), definition);
                scopes.set(owner, locals);
                return;
            }
            owner = owner.parent;
        }
    } });
    return scopes;
}

function resolveBinding(scopes: NodeWeakMap<Map<string, SyntaxNode>>, reference: SyntaxNode, text: string) {
    const name = spelling(reference, text);
    for (let scope = reference.parent; scope; scope = scope.parent) {
        const definition = scopes.get(scope)?.get(name);
        if (definition) return definition;
    }
}

// An unbound test/it is also accepted for snippets without an import. An explicitly bound
// runner must come from node:test, not a framework whose first parameter may be test data.
function isNodeRunner(definition: SyntaxNode | undefined, text: string, scopes: NodeWeakMap<Map<string, SyntaxNode>>): boolean {
    if (!definition) return true;
    let pattern = definition;
    while (pattern.parent && ['ImportGroup', 'PatternProperty', 'ObjectPattern'].includes(pattern.parent.name)) {
        pattern = pattern.parent;
    }
    const declaration = pattern.parent;
    if (declaration?.name === 'ImportDeclaration') {
        return !declaration.getChild('Star') && literal(declaration.getChild('String'), text) === 'node:test';
    }
    if (declaration?.name !== 'VariableDeclaration') return false;
    const equals = nextToken(pattern);
    const initializer = nextToken(equals);
    const loader = initializer?.firstChild;
    return equals?.name === 'Equals' && initializer?.name === 'CallExpression'
        && loader?.name === 'VariableName' && spelling(loader, text) === 'require'
        && !resolveBinding(scopes, loader, text)
        && literal(initializer.getChild('ArgList')?.getChild('String') ?? null, text) === 'node:test';
}

export function collectNodeSubtestTitles(text: string, filePath: string): Array<{ index: number; title: string }> {
    const tree = (/\.[jt]sx$/i.test(filePath) ? jsx : script).parse(text);
    const scopes = bindingScopes(tree, text);
    const contexts = new Set<number>();
    const titles: Array<{ index: number; title: string }> = [];
    tree.iterate({ enter(ref) {
        if (ref.name !== 'CallExpression') return;
        const call = ref.node;
        const callee = call.getChild('Expression');
        const member = callee?.name === 'MemberExpression';
        const receiver = member ? callee.getChild('Expression') : callee;
        if (receiver?.name !== 'VariableName') return;

        const method = member ? spelling(callee.getChild('PropertyName'), text) : '';
        const subtest = member && method === 'test';
        const binding = resolveBinding(scopes, receiver, text);
        if (subtest) {
            if (!binding || !contexts.has(binding.from)) return;
        } else {
            const root = spelling(receiver, text);
            if (root !== 'test' && root !== 'it') return;
            if ((member && !NODE_MODIFIERS.has(method)) || !isNodeRunner(binding, text, scopes)) return;
        }

        const args = call.getChild('ArgList')?.getChildren('Expression') ?? [];
        if (!args.length || args.length > 3) return;
        if (subtest) {
            const title = literal(args[0], text).trim();
            if (title) titles.push({ index: call.from, title });
        }

        const callback = args[args.length - 1];
        if (callback.name !== 'ArrowFunction' && callback.name !== 'FunctionExpression') return;
        const params = callback.getChild('ParamList');
        const first = params?.getChild('(') ? nextToken(params.getChild('(')) : params?.firstChild;
        if (first?.name === 'VariableDefinition') contexts.add(first.from);
    } });
    return titles;
}
