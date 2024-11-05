import * as core from '@actions/core'
import { context } from '@actions/github'
import type { components } from '@octokit/openapi-types'
import { newOctokitInstance } from './internal/octokit.js'

export type WorkflowRunStatus = components['parameters']['workflow-run-status']

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', { required: true })
const dryRun = core.getInput('dryRun').toLowerCase() === 'true'

const octokit = newOctokitInstance(githubToken)

const workflowRunStatusesToFind: WorkflowRunStatus[] = [
    'action_required',
    'stale',
    'in_progress',
    'queued',
    'requested',
    'waiting',
    'pending',
]

async function run(): Promise<void> {
    let cancelledWorkflowRuns = 0

    try {
        dump(`context`, context)

        const pullRequest = context.payload.pull_request
        if (pullRequest == null) {
            core.warning(`This action should be executed on 'pull_request' events. The current event: '${context.eventName}'.`)
            return
        }
        dump(`pullRequest: #${pullRequest?.number}`, pullRequest)

        const checkSuites = await octokit.paginate(octokit.checks.listSuitesForRef, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            ref: context.payload.pull_request?.head?.sha,
        })
        for (const checkSuite of checkSuites) {
            dump(`checkSuite: ${checkSuite.id}: ${checkSuite.app?.slug}`, checkSuite)
            if (checkSuite.app?.slug !== 'github-actions') {
                core.info(`  Skipping not a GitHub Actions check suite: ${checkSuite.url}`)
                continue
            }

            if (checkSuite.head_commit.id !== context.payload.pull_request?.head?.sha) {
                core.info(`  Skipping GitHub Action not for this Pull Request: ${checkSuite.url}`)
                continue
            }

            const workflowRuns = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
                owner: context.repo.owner,
                repo: context.repo.repo,
                check_suite_id: checkSuite.id,
                event: 'pull_request',
            })
            for (const workflowRun of workflowRuns) {
                dump(`  workflowRun`, workflowRun)

                if (workflowRun.id === context.runId) {
                    core.info(`  Skipping current workflow run: ${workflowRun.url}`)
                    continue
                }

                if (!workflowRun.status?.length
                    || !workflowRunStatusesToFind.includes(workflowRun.status as WorkflowRunStatus)
                ) {
                    core.info(`  Skipping workflow run: ${workflowRun.url}`)
                    continue
                }

                try {
                    core.warning(`  Cancelling workflow run: ${workflowRun.url}`)
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

function dump(name: string, object: any) {
    const isDumpAvailable = true || core.isDebug()
    if (!isDumpAvailable) {
        return
    }

    core.startGroup(name)
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
