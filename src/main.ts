import * as core from '@actions/core'
import { context } from '@actions/github'
import type { components } from '@octokit/openapi-types'
import { newOctokitInstance } from './internal/octokit'

export type WorkflowRun = components['schemas']['workflow-run']
export type WorkflowRunStatus = components['parameters']['workflow-run-status']

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', { required: true })
const _dryRun = core.getInput('dryRun', { required: true }).toLowerCase() === 'true'

const octokit = newOctokitInstance(githubToken)

function dump(name: string, object: any) {
    core.startGroup(name)
    core.info(JSON.stringify(
        object,
        (key, value) =>
            [
                '_links',
                'repository',
                'repo',
                'user',
                'owner',
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

async function run(): Promise<void> {
    try {
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

            const workflowRuns: WorkflowRun[] = []
            const workflowRunStatusesToFind: WorkflowRunStatus[] = [
                'queued',
                'in_progress',
            ]
            for (const workflowRunStatusToFind of workflowRunStatusesToFind) {
                const currentRuns = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    //event: 'pull_request',
                    check_suite_id: checkSuite.id,
                    status: workflowRunStatusToFind,
                })
                currentRuns.forEach(currentRun => {
                    if (!workflowRuns.some(it => it.id === currentRun.id)) {
                        workflowRuns.push(currentRun)
                    }
                })
            }

            dump(`workflowRuns`, workflowRuns)
        }

    } catch (error) {
        core.setFailed(error instanceof Error ? error : `${error}`)
        throw error
    }
}

//noinspection JSIgnoredPromiseFromCall
run()
