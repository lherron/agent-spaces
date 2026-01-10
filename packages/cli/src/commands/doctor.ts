/**
 * Doctor command - Check Claude, registry, cache permissions.
 *
 * WHY: Diagnoses common setup issues before users try to run,
 * providing clear guidance on what needs to be fixed.
 */

import { constants, access } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'

import { detectClaude } from '@agent-spaces/claude'
import { gitExec, listRemotes } from '@agent-spaces/git'
import { PathResolver, ensureAspHome, getAspHome } from '@agent-spaces/store'

import { findProjectRoot } from '../index.js'

interface CheckResult {
  name: string
  status: 'ok' | 'warning' | 'error'
  message: string
  detail?: string | undefined
}

/**
 * Register the doctor command.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check Claude binary, registry reachability, and cache permissions')
    .option('--json', 'Output as JSON')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      const checks: CheckResult[] = []

      // Check Claude binary
      try {
        const claude = await detectClaude()
        checks.push({
          name: 'claude',
          status: 'ok',
          message: `Claude found at ${claude.path}`,
          detail: `Version: ${claude.version ?? 'unknown'}`,
        })
      } catch (error) {
        checks.push({
          name: 'claude',
          status: 'error',
          message: 'Claude not found',
          detail: error instanceof Error ? error.message : String(error),
        })
      }

      // Check ASP_HOME
      const aspHome = options.aspHome ?? getAspHome()
      const paths = new PathResolver({ aspHome })

      try {
        await ensureAspHome()
        checks.push({
          name: 'asp_home',
          status: 'ok',
          message: `ASP_HOME: ${aspHome}`,
        })
      } catch (error) {
        checks.push({
          name: 'asp_home',
          status: 'error',
          message: `Cannot create ASP_HOME: ${aspHome}`,
          detail: error instanceof Error ? error.message : String(error),
        })
      }

      // Check cache directory
      try {
        await access(paths.cache, constants.W_OK)
        checks.push({
          name: 'cache',
          status: 'ok',
          message: `Cache directory writable: ${paths.cache}`,
        })
      } catch {
        try {
          await access(paths.cache, constants.R_OK)
          checks.push({
            name: 'cache',
            status: 'warning',
            message: `Cache directory read-only: ${paths.cache}`,
          })
        } catch {
          checks.push({
            name: 'cache',
            status: 'ok',
            message: `Cache directory will be created: ${paths.cache}`,
          })
        }
      }

      // Check store directory
      try {
        await access(paths.store, constants.W_OK)
        checks.push({
          name: 'store',
          status: 'ok',
          message: `Store directory writable: ${paths.store}`,
        })
      } catch {
        try {
          await access(paths.store, constants.R_OK)
          checks.push({
            name: 'store',
            status: 'warning',
            message: `Store directory read-only: ${paths.store}`,
          })
        } catch {
          checks.push({
            name: 'store',
            status: 'ok',
            message: `Store directory will be created: ${paths.store}`,
          })
        }
      }

      // Check registry
      let registryExists = false
      try {
        await access(paths.repo, constants.R_OK)
        registryExists = true
        checks.push({
          name: 'registry',
          status: 'ok',
          message: `Registry found: ${paths.repo}`,
        })
      } catch {
        checks.push({
          name: 'registry',
          status: 'warning',
          message: 'No local registry found',
          detail: `Expected at: ${paths.repo}. Run 'asp repo init' to create one.`,
        })
      }

      // Check registry remote reachability (if registry exists)
      if (registryExists) {
        try {
          const remotes = await listRemotes({ cwd: paths.repo })
          const origin = remotes.find((r) => r.name === 'origin')

          if (origin && origin.fetchUrl) {
            // Try to connect to remote using ls-remote (with timeout)
            const result = await gitExec(['ls-remote', '--heads', origin.fetchUrl], {
              cwd: paths.repo,
              timeout: 10000, // 10 second timeout
              ignoreExitCode: true,
            })

            if (result.exitCode === 0) {
              checks.push({
                name: 'registry_remote',
                status: 'ok',
                message: `Registry remote reachable: ${origin.fetchUrl}`,
              })
            } else {
              checks.push({
                name: 'registry_remote',
                status: 'warning',
                message: `Registry remote unreachable: ${origin.fetchUrl}`,
                detail: 'Check your network connection or remote URL configuration.',
              })
            }
          } else {
            checks.push({
              name: 'registry_remote',
              status: 'warning',
              message: 'No remote configured for registry',
              detail: 'The registry is local-only. Add a remote with git remote add origin <url>.',
            })
          }
        } catch (error) {
          checks.push({
            name: 'registry_remote',
            status: 'warning',
            message: 'Could not check registry remote',
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }

      // Check project
      const projectPath = options.project ?? (await findProjectRoot())
      if (projectPath) {
        checks.push({
          name: 'project',
          status: 'ok',
          message: `Project found: ${projectPath}`,
        })
      } else {
        checks.push({
          name: 'project',
          status: 'warning',
          message: 'No project found in current directory',
          detail: 'Run this command from a project directory with asp-targets.toml',
        })
      }

      // Output results
      if (options.json) {
        console.log(JSON.stringify({ checks }, null, 2))
      } else {
        console.log(chalk.blue('Agent Spaces Doctor\n'))

        let hasError = false
        let hasWarning = false

        for (const check of checks) {
          const icon =
            check.status === 'ok'
              ? chalk.green('✓')
              : check.status === 'warning'
                ? chalk.yellow('!')
                : chalk.red('✗')

          const color =
            check.status === 'ok'
              ? chalk.green
              : check.status === 'warning'
                ? chalk.yellow
                : chalk.red

          console.log(`${icon} ${color(check.message)}`)
          if (check.detail) {
            console.log(`  ${chalk.gray(check.detail)}`)
          }

          if (check.status === 'error') hasError = true
          if (check.status === 'warning') hasWarning = true
        }

        console.log('')
        if (hasError) {
          console.log(chalk.red('Some checks failed. Please fix the issues above.'))
          process.exit(1)
        } else if (hasWarning) {
          console.log(chalk.yellow('Some warnings found. Review the messages above.'))
        } else {
          console.log(chalk.green('All checks passed!'))
        }
      }
    })
}
