import { Command } from 'commander';

const LIST_RBT_COMMANDS = String.raw`rbt --help | awk '/Commands:/{flag=1;next}/^\s*$/ {if(flag) exit}flag{print $1}'`;

const COMPLETION_SCRIPTS = new Map([
    ['bash', `#!/usr/bin/env bash
_rbt_completions() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    COMPREPLY=( $(compgen -W "$(${LIST_RBT_COMMANDS})" -- "$cur") )
}
complete -F _rbt_completions rbt
`],
    ['zsh', `#compdef rbt
_rbt() {
    local -a commands
    commands=($(${LIST_RBT_COMMANDS}))
    _describe 'commands' commands
}
compdef _rbt rbt
`],
]);

export function registerCompletionCommand(program: Command): void {
    program
        .command('completion')
        .description('Print shell completion script')
        .argument('[shell]', 'Shell: bash or zsh', 'bash')
        .action((shell: string) => {
            const script = COMPLETION_SCRIPTS.get(shell);
            if (!script) {
                console.error('Unsupported shell. Try bash or zsh.');
                process.exitCode = 1;
                return;
            }
            console.log(script);
        });
}
