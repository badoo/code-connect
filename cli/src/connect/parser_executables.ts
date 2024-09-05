import { z } from 'zod'
import { exitWithError, logger } from '../common/logging'
import {
  CodeConnectExecutableParserConfig,
  FirstPartyExecutableParser,
  FirstPartyParser,
} from './project'
import {
  CreateResponsePayload,
  ParserExecutableMessages,
  ParserRequestPayload,
} from './parser_executable_types'
import { spawn } from 'cross-spawn'
import { getSwiftParserDir } from '../parser_scripts/get_swift_parser_dir'
import fs from 'fs'
import path from 'path'
import {
  getGradleWrapperExecutablePath,
  getGradleWrapperPath,
} from '../parser_scripts/get_gradlew_path'
import { getComposeErrorSuggestion } from '../parser_scripts/compose_errors'
import { getCustomSwiftCLIPath } from '../parser_scripts/get_custom_swift_parse'

const temporaryInputFilePath = 'tmp/figma-code-connect-parser-input.json.tmp'

type ParserInfo = {
  command: (
    cwd: string,
    config: CodeConnectExecutableParserConfig,
    mode: ParserRequestPayload['mode'],
  ) => Promise<string>
  temporaryInputFilePath?: string
}

const FIRST_PARTY_PARSERS: Record<FirstPartyExecutableParser, ParserInfo> = {
  swift: {
    command: async (cwd, config, mode) => {
      if (config.customSwiftCLIPath) {
        const customCLIPath = path.join(getCustomSwiftCLIPath(cwd), `${config.customSwiftCLIPath}`)
        return customCLIPath
      } else {
        return `swift run --package-path ${await getSwiftParserDir(cwd, (config as any).xcodeprojPath)} figma-swift`
      }
    },
  },
  compose: {
    command: async (cwd, config, mode) => {
      const gradlewPath = await getGradleWrapperPath(cwd, (config as any).gradleWrapperPath)
      const gradleExecutableInvocation = getGradleWrapperExecutablePath(gradlewPath)
      if (mode === 'CREATE') {
        return `${gradleExecutableInvocation} -p ${gradlewPath} createCodeConnect -PfilePath=${temporaryInputFilePath} -q`
      } else {
        return `${gradleExecutableInvocation} -p ${gradlewPath} parseCodeConnect -PfilePath=${temporaryInputFilePath} -q`
      }
    },
    temporaryInputFilePath: temporaryInputFilePath,
  },
  __unit_test__: {
    command: async () => 'node parser/unit_test_parser.js',
  },
}

function getParser(config: CodeConnectExecutableParserConfig): ParserInfo | never {
  const parser = FIRST_PARTY_PARSERS[config.parser]

  if (!parser) {
    exitWithError(
      `Invalid parser specified: "${config.parser}". Valid parsers are: ${Object.keys(FIRST_PARTY_PARSERS).join(', ')}.`,
    )
  }

  return parser
}

export async function callParser(
  config: CodeConnectExecutableParserConfig,
  payload: ParserRequestPayload,
  cwd: string,
) {
  return new Promise<object>(async (resolve, reject) => {
    try {
      const parser = getParser(config)
      const command = await parser.command(cwd, config, payload.mode)
      if (parser.temporaryInputFilePath) {
        fs.mkdirSync(path.dirname(parser.temporaryInputFilePath), { recursive: true })
        fs.writeFileSync(temporaryInputFilePath, JSON.stringify(payload))
      }
      logger.debug(`Running parser: ${command}`)
      const commandSplit = command.split(' ')

      const child = spawn(commandSplit[0], commandSplit.slice(1), {
        cwd,
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      // This handles any stderr output from the parser.
      //
      // Parsers should not generally write to stderr, and should instead return
      // an array of messages at the end of execution, but there are cases where
      // you might want to log output immediately rather than at the end of the
      // run - e.g. if the parser can take a while to compile first time, you
      // might want to inform the user immediately that it is compiling.
      //
      // To log output, the parser should write a JSON object to stderr with the
      // same structure as the `messages` response object, e.g. `{ "level":
      // "INFO", "message": "Compiling parser..." }`.
      //
      // Non-JSON output will be logged as debug messages, as this is likely to
      // be e.g. compiler output which the user doesn't need to see ordinarily.
      child.stderr.on('data', (data) => {
        const message = data.toString()
        const trimmedMessage = message.trim()
        try {
          const parsed = JSON.parse(trimmedMessage)
          handleMessages([parsed])
        } catch (e) {
          stderr += message
          logger.debug(trimmedMessage)
        }
      })

      child.on('close', (code) => {
        if (code !== 0) {
          const errorSuggestion = determineErrorSuggestionFromStderr(stderr, config.parser)
          if (errorSuggestion) {
            reject(new Error(`Parser exited with code ${code}: ${errorSuggestion}`))
          } else {
            reject(new Error(`Parser exited with code ${code}`))
          }
        } else {
          resolve(JSON.parse(stdout))
        }
        if (parser.temporaryInputFilePath) {
          fs.unlinkSync(parser.temporaryInputFilePath)
        }
      })

      child.on('error', (e) => {
        reject(e)
      })
      if (!parser.temporaryInputFilePath) {
        child.stdin.write(JSON.stringify(payload))
        child.stdin.end()
      }
    } catch (e) {
      exitWithError(
        `Error calling parser: ${e}. Try re-running the command with --verbose for more information.`,
      )
    }
  })
}

export function handleMessages(messages: z.infer<typeof ParserExecutableMessages>) {
  let hasErrors = false

  messages.forEach((message) => {
    switch (message.level) {
      case 'DEBUG':
        logger.debug(message.message)
        break
      case 'INFO':
        logger.info(message.message)
        break
      case 'WARN':
        logger.warn(message.message)
        break
      case 'ERROR':
        logger.error(message.message)
        hasErrors = true
        break
    }
  })

  return { hasErrors }
}

// This function is used to determine if there is a suggestion for the error based on the output
// to stderr. Certain parsers return the same error code for different types of errors such as
// errors from invoking the gradle wrapper for Compose.
// In the future we should consider exposing a different API for having the parser return a suggestion directly.
function determineErrorSuggestionFromStderr(
  stderr: string,
  parser: FirstPartyParser,
): string | null {
  if (parser === 'compose') {
    return getComposeErrorSuggestion(stderr)
  }
  return null
}
