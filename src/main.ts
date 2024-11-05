import * as core from '@actions/core'
import { context } from '@actions/github'
import type { components } from '@octokit/openapi-types'
import { newOctokitInstance } from './internal/octokit.js'

export type CheckSuite = components['schemas']['check-suite']
export type WorkflowRun = components['schemas']['workflow-run']
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

const checkSuiteCreationDelayMillis = 0

const cancelAttempts = 10
const cancelRetryDelayMillis = 2_500

async function run(): Promise<void> {
    try {
        log(`context`, context)

        const pullRequest = context.payload.pull_request
        if (pullRequest == null) {
            core.warning(`This action should be executed on 'pull_request' events. The current event: '${context.eventName}'.`)
            return
        }
        log(`pullRequest: #${pullRequest?.number}`, pullRequest)

        const now = Date.now()

        async function processCheckSuite(checkSuite: CheckSuite) {
            log(`checkSuite: ${checkSuite.id}: ${checkSuite.app?.slug}`, checkSuite)
            if (checkSuite.app?.slug !== 'github-actions') {
                log(`Skipping not a GitHub Actions check suite: ${checkSuite.url}`)
                return
            }

            if (checkSuite.head_commit.id !== context.payload.pull_request?.head?.sha) {
                log(`Skipping GitHub Action not for this Pull Request: ${checkSuite.url}`)
                return
            }

            if (checkSuite.status != null && !statusesToFind.includes(checkSuite.status)) {
                log(`Skipping completed GitHub Action check suite: ${checkSuite.url}: ${checkSuite.status}`)
                return
            }

            if (checkSuite.created_at?.length) {
                const createdAt = new Date(checkSuite.created_at).getTime()
                const delayMillis = createdAt - (now - checkSuiteCreationDelayMillis)
                if (delayMillis > 0) {
                    log(`delayMillis`, delayMillis)
                    await sleep(delayMillis)
                }
            }


            async function processWorkflowRun(workflowRun: WorkflowRun, attempt: number = 1) {
                if (attempt > 1) {
                    workflowRun = await octokit.actions.getWorkflowRun({
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        run_id: workflowRun.id,
                    }).then(it => it.data)
                }
                log(`workflowRun: ${workflowRun.id} (attempt ${attempt})`, workflowRun)

                if (workflowRun.id === context.runId) {
                    log(`Skipping current workflow run: ${workflowRun.url}`)
                    return
                }

                if (!statusesToFind.includes(workflowRun.status as WorkflowRunStatus)) {
                    log(`Skipping workflow run: ${workflowRun.url}: ${workflowRun.status}`)
                    return
                }

                try {
                    if (attempt > cancelAttempts) {
                        core.warning(`Forcefully cancelling workflow run: ${workflowRun.url} (attempt ${attempt})`)
                        if (dryRun) {
                            return
                        }

                        await octokit.actions.forceCancelWorkflowRun({
                            owner: context.repo.owner,
                            repo: context.repo.repo,
                            run_id: workflowRun.id,
                        })
                        return
                    }

                    core.warning(`Cancelling workflow run: ${workflowRun.url} (attempt ${attempt})`)
                    if (dryRun) {
                        return
                    }

                    await octokit.actions.cancelWorkflowRun({
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        run_id: workflowRun.id,
                    })
                } catch (e) {
                    core.error(e instanceof Error ? e.message : `${e}`)
                }

                await sleep(cancelRetryDelayMillis)
                return processWorkflowRun(workflowRun, attempt + 1)
            }

            const workflowRuns = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
                owner: context.repo.owner,
                repo: context.repo.repo,
                check_suite_id: checkSuite.id,
                event: 'pull_request',
            })
            await Promise.all(workflowRuns.map(it => processWorkflowRun(it)))
        }

        const checkSuites = await octokit.paginate(octokit.checks.listSuitesForRef, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            ref: context.payload.pull_request?.head?.sha,
        })

        await Promise.all(checkSuites.map(processCheckSuite))

    } catch (error) {
        core.setFailed(error instanceof Error ? error : `${error}`)
        throw error
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

function log(message: string, object: any = undefined) {
    const isDumpAvailable = core.isDebug()
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
