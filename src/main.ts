import * as core from '@actions/core'
import { context } from '@actions/github'
import type { components } from '@octokit/openapi-types'
import { newOctokitInstance } from './internal/octokit.js'

export type WorkflowRun = components['schemas']['workflow-run']
export type WorkflowRunStatus = components['parameters']['workflow-run-status']

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', { required: true })
const dryRun = core.getInput('dryRun', { required: true }).toLowerCase() === 'true'

const octokit = newOctokitInstance(githubToken)

async function run(): Promise<void> {
    try {
        dump(`context`, context)
        const pullRequest = context.payload.pull_request
        dump(`pullRequest: ${pullRequest?.number}`, pullRequest)
        if (pullRequest == null) {
            core.warning(`This action should be executed on 'pull_request' events. The current event: '${context.eventName}'.`)
            return
        }

        const checkSuites = await octokit.paginate(octokit.checks.listSuitesForRef, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            ref: context.payload.pull_request?.head?.sha,
        })
        for (const checkSuite of checkSuites) {
            dump(`checkSuite: ${checkSuite.id}: ${checkSuite.app?.slug}`, checkSuite)
            if (checkSuite.app?.slug !== 'github-actions'
                || checkSuite.pull_requests?.length !== 1
                || checkSuite.pull_requests[0].number !== context.payload.pull_request?.number
            ) {
                continue
            }

            const workflowRunStatusesToFind: WorkflowRunStatus[] = [
                'queued',
                'in_progress',
            ]
            const processedWorkflowRunIds = new Set<number>()
            for (const workflowRunStatusToFind of workflowRunStatusesToFind) {
                const workflowRuns = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    //event: 'pull_request',
                    check_suite_id: checkSuite.id,
                    status: workflowRunStatusToFind,
                })
                for (const workflowRun of workflowRuns) {
                    if (processedWorkflowRunIds.has(workflowRun.id)) {
                        continue
                    } else {
                        processedWorkflowRunIds.add(workflowRun.id)
                    }

                    dump(`  workflowRun`, workflowRun)

                    if (workflowRun.id === context.runId) {
                        core.info(`Skipping current workflow run: ${workflowRun.url}`)
                        continue
                    }

                    try {
                        core.warning(`Cancelling workflow run: ${workflowRun.url}`)
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
        }

    } catch (error) {
        core.setFailed(error instanceof Error ? error : `${error}`)
        throw error
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

function dump(name: string, object: any) {
    const isDumpAvailable = false
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
            ].includes(key)
                ? null
                : value,
        2,
    ))
    core.endGroup()
}
