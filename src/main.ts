import * as core from '@actions/core'
import { context } from '@actions/github'
import type { components } from '@octokit/openapi-types'
import { newOctokitInstance } from './internal/octokit.js'

export type CheckSuite = components['schemas']['check-suite']
export type WorkflowRunStatus = components['parameters']['workflow-run-status']

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', { required: true })
const dryRun = core.getInput('dryRun').toLowerCase() === 'true'

const octokit = newOctokitInstance(githubToken)

const statusesToFind: WorkflowRunStatus[] = [
    'action_required',
    'stale',
    'in_progress',
    'queued',
    'requested',
    'waiting',
    'pending',
]

const checkSuiteCreationDelayMillis = 5_000

async function run(): Promise<void> {
    let cancelledWorkflowRuns = 0

    try {
        log(`context`, context)

        const pullRequest = context.payload.pull_request
        if (pullRequest == null) {
            core.warning(`This action should be executed on 'pull_request' events. The current event: '${context.eventName}'.`)
            return
        }
        log(`pullRequest: #${pullRequest?.number}`, pullRequest)

        let checkSuites: CheckSuite[] = []
        const maxAttempts = 2
        for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
            checkSuites = await octokit.paginate(octokit.checks.listSuitesForRef, {
                owner: context.repo.owner,
                repo: context.repo.repo,
                ref: context.payload.pull_request?.head?.sha,
            })

            const createdAtTimestamps = checkSuites
                .map(it => it.created_at)
                .map(it => it != null ? new Date(it) : new Date())
                .map(it => it.getTime())

            if (!createdAtTimestamps.length) {
                if (attempt < maxAttempts) {
                    core.info(`No check suites were found, retrying`)
                    await sleep(checkSuiteCreationDelayMillis)
                    continue
                } else {
                    break
                }
            }

            const createdAtMaxTimestamp = Math.max(...createdAtTimestamps)
            const delayMillis = createdAtMaxTimestamp - (Date.now() - checkSuiteCreationDelayMillis)
            if (delayMillis > 0 && attempt < maxAttempts) {
                core.info(`Too new check suites were found, retrying`)
                await sleep(delayMillis)
                continue
            }

            break
        }
        for (const checkSuite of checkSuites) {
            log(`checkSuite: ${checkSuite.id}: ${checkSuite.app?.slug}`, checkSuite)
            if (checkSuite.app?.slug !== 'github-actions') {
                log(`Skipping not a GitHub Actions check suite: ${checkSuite.url}`)
                continue
            }

            if (checkSuite.head_commit.id !== context.payload.pull_request?.head?.sha) {
                log(`Skipping GitHub Action not for this Pull Request: ${checkSuite.url}`)
                continue
            }

            if (checkSuite.status != null && !statusesToFind.includes(checkSuite.status)) {
                log(`Skipping completed GitHub Action check suite: ${checkSuite.url}: ${checkSuite.status}`)
                continue
            }

            const workflowRuns = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
                owner: context.repo.owner,
                repo: context.repo.repo,
                check_suite_id: checkSuite.id,
                event: 'pull_request',
            })
            for (const workflowRun of workflowRuns) {
                log(`workflowRun: ${workflowRun.id}`, workflowRun)

                if (workflowRun.id === context.runId) {
                    log(`Skipping current workflow run: ${workflowRun.url}`)
                    continue
                }

                if (!workflowRun.status?.length
                    || !statusesToFind.includes(workflowRun.status as WorkflowRunStatus)
                ) {
                    log(`Skipping workflow run: ${workflowRun.url}: ${workflowRun.status}`)
                    continue
                }

                try {
                    core.warning(`Cancelling workflow run: ${workflowRun.url}`)
                    ++cancelledWorkflowRuns
                    if (dryRun) {
                        await octokit.actions.cancelWorkflowRun({
                            owner: context.repo.owner,
                            repo: context.repo.repo,
                            run_id: workflowRun.id,
                        })
                    }
                } catch (e) {
                    core.error(e instanceof Error ? e.message : `${e}`)
                }
            }
        }

    } catch (error) {
        core.setFailed(error instanceof Error ? error : `${error}`)
        throw error

    } finally {
        core.setOutput('cancelledWorkflowRuns', cancelledWorkflowRuns)
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

function log(message: string, object: any = undefined) {
    const isDumpAvailable = true || core.isDebug()
    if (!isDumpAvailable) {
        return
    }

    if (object === undefined) {
        core.info(message)
        return
    }

    core.startGroup(message)
    core.info(JSON.stringify(
        object,
        (key, value) =>
            [
                '_links',
                'repository',
                'head_repository',
                'repo',
                'user',
                'owner',
                'organization',
                'sender',
                'actor',
                'triggering_actor',
                'body',
                'labels',
                'assignee',
                'assignees',
                'requested_reviewers',
                'events',
                'permissions',
            ].includes(key)
                ? null
                : value,
        2,
    ))
    core.endGroup()
}

function sleep(millis: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, millis)
    })
}
