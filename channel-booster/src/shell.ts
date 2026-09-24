/**
 * Arguments in a command the booster prints for a person to paste into a
 * shell: a path they chose or a value they typed goes back in the way a POSIX
 * shell reads it. Double quotes are not enough: inside them the shell still
 * expands $, backticks and !, so a folder named `chan$one` would come back as
 * `chan`.
 */

/** One argument as a POSIX shell reads it back: as is when every character is plain, else in single quotes. */
export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
