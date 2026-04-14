import { Command } from 'commander';

const BASH_COMPLETION = `#!/usr/bin/env bash
_rbt_completions() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    COMPREPLY=( $(compgen -W "$(rbt --help | awk '/Commands:/{flag=1;next}/^\\s*$/ {if(flag) exit}flag{print $1}')" -- "$cur") )
}
complete -F _rbt_completions rbt
`;

const ZSH_COMPLETION = `#compdef rbt
_rbt() {
    local -a commands
    commands=($(rbt --help | awk '/Commands:/{flag=1;next}/^\\s*$/ {if(flag) exit}flag{print $1}'))
    _describe 'commands' commands
}
compdef _rbt rbt
`;

export function registerCompletionCommand(program: Command): void {
    program
        .command('completion')
        .description('Print shell completion script')
        .argument('[shell]', 'Shell: bash or zsh', 'bash')
        .action(async (shell: string) => {
            if (shell === 'bash') {
                console.log(BASH_COMPLETION);
                return;
            }

            if (shell === 'zsh') {
                console.log(ZSH_COMPLETION);
                return;
            }

            console.error('Unsupported shell. Try bash or zsh.');
            process.exitCode = 1;
        });
}
