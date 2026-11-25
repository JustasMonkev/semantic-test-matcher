import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { findImportWitnesses } from '../src/services/import-witnesses.ts';

it('uses static declarations and exact local regular files, not spellings or unbounded graph traversal', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-edges-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'workspace');
    await fs.mkdir(root);
    const target = path.join(root, 'target.js');
    const files: Record<string, string> = {
        'target.js': 'export const limit = 1;',
        'barrel.js': "export * from './target.js';",
        'layer.js': "import './barrel.js';",
        'two.mjs': "import './barrel.js';",
        'direct.mjs': "export * from './barrel.js'; import './target.js';",
        'three.mjs': "import './layer.js';",
        'fake.mjs': "/* import './target.js' */ const text = \"import './target.js'\"; import('./target.js');",
        'unsupported.mjs': "import './target'; import './target.js?other'; import './target%2Ejs';",
        'cycle.mjs': "import './cycle.mjs';",
        'past-cap.mjs': Array.from({ length: 64 }, (_, n) => `import './absent-${n}.js';`).join('\n') + "\nimport './target.js';",
        'invalid.mjs': "import './target.js'; const = ;",
        'large.mjs': "import './target.js';" + ' '.repeat(128 * 1024),
        'escape.mjs': "import './link.js'; import '../outside.js';",
    };
    await Promise.all(Object.entries(files).map(([name, value]) => fs.writeFile(path.join(root, name), value)));
    // Never borrow edges from a symlink, even if its contents look like a local module.
    await fs.writeFile(path.join(directory, 'outside.js'), "export * from './target.js';");
    await fs.symlink(path.join(directory, 'outside.js'), path.join(root, 'link.js'));
    const candidates = Object.keys(files).filter(name => name.endsWith('.mjs'));
    const witnesses = await findImportWitnesses(root, candidates, [target, path.join(root, 'link.js')]);
    assert.deepEqual([...witnesses.keys()], [target]);
    assert.deepEqual(witnesses.get(target), new Map([
        ['direct.mjs', ['direct.mjs', 'target.js']],
        ['two.mjs', ['two.mjs', 'barrel.js', 'target.js']],
    ]));
});
