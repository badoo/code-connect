const _stripAnsi = require('strip-ansi')

/**
 * Tidy up the output from stdout, removing ANSI codes and trimming whitespace
 * so that it's easier for tests to compare against the expected output.
 *
 * ANSI codes differ across operating systems, so it's hard to test those
 * otherwise, and also they create a lot of noise in the assertions. This does
 * mean we don't test the colour/formatting of the output.
 */
export function tidyStdOutput(input: string): string {
  return (
    _stripAnsi(input.trim())
      // remove any leading newlines
      .replace(/^\n+/, '')
      // remove any trailing newlines
      .replace(/\n+$/, '')
      .split('\n')
      // trim trailing space only
      .map((line: string) => line.replace(/\s+$/, ''))
      .join('\n')
  )
}
