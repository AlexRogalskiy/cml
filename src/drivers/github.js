const url = require('url');
const { spawn } = require('child_process');
const { resolve } = require('path');
const fs = require('fs').promises;
const fetch = require('node-fetch');

const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');
const { withCustomRequest } = require('@octokit/graphql');
const { throttling } = require('@octokit/plugin-throttling');
const tar = require('tar');
const ProxyAgent = require('proxy-agent');

const { download, exec } = require('../utils');
const winston = require('winston');

const CHECK_TITLE = 'CML Report';
process.env.RUNNER_ALLOW_RUNASROOT = 1;

const {
  GITHUB_REPOSITORY,
  GITHUB_SHA,
  GITHUB_REF,
  GITHUB_HEAD_REF,
  GITHUB_EVENT_NAME,
  GITHUB_RUN_ID,
  GITHUB_TOKEN,
  CI,
  TPI_TASK
} = process.env;

const branchName = (branch) => {
  if (!branch) return;

  return branch.replace(/refs\/(head|tag)s\//, '');
};

const ownerRepo = (opts) => {
  let owner, repo;
  const { uri } = opts;

  if (uri) {
    const { pathname } = new URL(uri);
    [owner, repo] = pathname.substr(1).split('/');
  } else if (GITHUB_REPOSITORY) {
    [owner, repo] = GITHUB_REPOSITORY.split('/');
  }

  return { owner, repo };
};

const octokit = (token, repo) => {
  if (!token) throw new Error('token not found');

  const throttleHandler = (retryAfter, options) => {
    if (options.request.retryCount <= 5) {
      winston.info(`Retrying after ${retryAfter} seconds!`);
      return true;
    }
  };
  const octokitOptions = {
    request: { agent: new ProxyAgent() },
    auth: token,
    throttle: {
      onRateLimit: throttleHandler,
      onAbuseLimit: throttleHandler
    }
  };

  if (!repo.includes('github.com')) {
    // GitHub Enterprise, use the: repo URL host + '/api/v3' - as baseURL
    // as per: https://developer.github.com/enterprise/v3/enterprise-admin/#endpoint-urls
    const { host } = new url.URL(repo);
    octokitOptions.baseUrl = `https://${host}/api/v3`;
  }

  const MyOctokit = Octokit.plugin(throttling);
  return new MyOctokit(octokitOptions);
};

class Github {
  constructor(opts = {}) {
    const { repo, token } = opts;

    if (!repo) throw new Error('repo not found');
    if (!token) throw new Error('token not found');

    this.repo = repo;
    this.token = token;
  }

  ownerRepo(opts = {}) {
    const { uri = this.repo } = opts;
    return ownerRepo({ uri });
  }

  async commentCreate(opts = {}) {
    const { report: body, commitSha } = opts;
    const { repos } = octokit(this.token, this.repo);

    return (
      await repos.createCommitComment({
        ...ownerRepo({ uri: this.repo }),
        commit_sha: commitSha,
        body
      })
    ).data.html_url;
  }

  async commentUpdate(opts = {}) {
    const { report: body, id } = opts;
    const { repos } = octokit(this.token, this.repo);

    return (
      await repos.updateCommitComment({
        ...ownerRepo({ uri: this.repo }),
        comment_id: id,
        body
      })
    ).data.html_url;
  }

  async commitComments(opts = {}) {
    const { commitSha } = opts;
    const { repos, paginate } = octokit(this.token, this.repo);

    return (
      await paginate(repos.listCommentsForCommit, {
        ...ownerRepo({ uri: this.repo }),
        commit_sha: commitSha
      })
    ).map(({ id, body }) => {
      return { id, body };
    });
  }

  async commitPrs(opts = {}) {
    const { commitSha, state = 'open' } = opts;
    const { repos } = octokit(this.token, this.repo);

    return (
      await repos.listPullRequestsAssociatedWithCommit({
        ...ownerRepo({ uri: this.repo }),
        commit_sha: commitSha,
        state
      })
    ).data.map((pr) => {
      const {
        html_url: url,
        head: { ref: source },
        base: { ref: target }
      } = pr;
      return {
        url,
        source: branchName(source),
        target: branchName(target)
      };
    });
  }

  async checkCreate(opts = {}) {
    const {
      report,
      headSha,
      title = CHECK_TITLE,
      started_at: startedAt = new Date(),
      completed_at: completedAt = new Date(),
      conclusion = 'success',
      status = 'completed'
    } = opts;

    const warning =
      'This command only works inside a Github runner or a Github app.';

    if (!CI || TPI_TASK) winston.warn(warning);
    if (GITHUB_TOKEN && GITHUB_TOKEN !== this.token)
      winston.warn(
        `Your token is different than the GITHUB_TOKEN, this command does not work with PAT. ${warning}`
      );

    const name = title;
    return await octokit(this.token, this.repo).checks.create({
      ...ownerRepo({ uri: this.repo }),
      head_sha: headSha,
      started_at: startedAt,
      completed_at: completedAt,
      conclusion,
      status,
      name,
      output: { title, summary: report }
    });
  }

  async upload() {
    throw new Error('Github does not support publish!');
  }

  async runnerToken() {
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { actions } = octokit(this.token, this.repo);

    if (typeof repo !== 'undefined') {
      const {
        data: { token }
      } = await actions.createRegistrationTokenForRepo({
        owner,
        repo
      });

      return token;
    }

    const {
      data: { token }
    } = await actions.createRegistrationTokenForOrg({
      org: owner
    });

    return token;
  }

  async registerRunner() {
    throw new Error('Github does not support registerRunner!');
  }

  async unregisterRunner(opts) {
    winston.info(`driver.github.unregisterRunner`, opts);
    const { runnerId } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { actions } = octokit(this.token, this.repo);

    if (typeof repo !== 'undefined') {
      const res = await actions.deleteSelfHostedRunnerFromRepo({
        owner,
        repo,
        runner_id: runnerId
      });
      winston.info('actions.deleteSelfHostedRunnerFromRepo response', res);
    } else {
      const res = await actions.deleteSelfHostedRunnerFromOrg({
        org: owner,
        runner_id: runnerId
      });
      winston.info('actions.deleteSelfHostedRunnerFromOrg response', res);
    }
  }

  async startRunner(opts) {
    const { workdir, single, name, labels } = opts;

    try {
      const runnerCfg = resolve(workdir, '.runner');

      try {
        await fs.unlink(runnerCfg);
      } catch (e) {
        const arch = process.platform === 'darwin' ? 'osx-x64' : 'linux-x64';
        const { tag_name: ver } = await (
          await fetch(
            'https://api.github.com/repos/actions/runner/releases/latest'
          )
        ).json();
        const destination = resolve(workdir, 'actions-runner.tar.gz');
        const url = `https://github.com/actions/runner/releases/download/${ver}/actions-runner-${arch}-${ver.substring(
          1
        )}.tar.gz`;
        await download({ url, path: destination });
        await tar.extract({ file: destination, cwd: workdir });
        await exec(`chmod -R 777 ${workdir}`);
      }

      await exec(
        `${resolve(
          workdir,
          'config.sh'
        )} --unattended --token "${await this.runnerToken()}" --url "${
          this.repo
        }" --name "${name}" --labels "${labels}" --work "${resolve(
          workdir,
          '_work'
        )}" ${single ? ' --ephemeral' : ''}`
      );

      return spawn(resolve(workdir, 'run.sh'), {
        shell: true
      });
    } catch (err) {
      throw new Error(`Failed preparing GitHub runner: ${err.message}`);
    }
  }

  async runners(opts = {}) {
    winston.info('driver.github.runners');
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { paginate, actions } = octokit(this.token, this.repo);

    let runners;
    if (typeof repo === 'undefined') {
      runners = await paginate(actions.listSelfHostedRunnersForOrg, {
        org: owner,
        per_page: 100
      });
    } else {
      runners = await paginate(actions.listSelfHostedRunnersForRepo, {
        owner,
        repo,
        per_page: 100
      });
    }
    winston.info(
      `driver.github.runners api results: ${JSON.stringify(runners)}`
    );
    return runners.map((runner) => this.parseRunner(runner));
  }

  async runnerById(opts = {}) {
    const { id } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { actions } = octokit(this.token, this.repo);

    if (typeof repo === 'undefined') {
      const { data: runner } = await actions.getSelfHostedRunnerForOrg({
        org: owner,
        runner_id: id
      });

      return this.parseRunner(runner);
    }

    const { data: runner } = await actions.getSelfHostedRunnerForRepo({
      owner,
      repo,
      runner_id: id
    });

    return this.parseRunner(runner);
  }

  parseRunner(runner) {
    const { id, name, busy, status, labels } = runner;
    return {
      id,
      name,
      labels: labels.map(({ name }) => name),
      online: status === 'online',
      busy
    };
  }

  async prCreate(opts = {}) {
    const {
      source: head,
      target: base,
      title,
      description: body,
      autoMerge
    } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { pulls } = octokit(this.token, this.repo);

    const {
      data: { html_url: htmlUrl, number }
    } = await pulls.create({
      owner,
      repo,
      head,
      base,
      title,
      body
    });

    if (autoMerge)
      await this.prAutoMerge({
        pullRequestId: number,
        mergeMode: autoMerge,
        base
      });
    return htmlUrl;
  }

  /**
   * @param {{ branch: string }} opts
   * @returns {Promise<boolean>}
   */
  async isProtected({ branch }) {
    const octo = octokit(this.token, this.repo);
    const { owner, repo } = this.ownerRepo();
    try {
      await octo.repos.getBranchProtection({
        branch,
        owner,
        repo
      });
      return true;
    } catch (error) {
      if (error.message === 'Branch not protected') {
        return false;
      }
      throw error;
    }
  }

  /**
   * @param {{ pullRequestId: number, base: string }} param0
   * @returns {Promise<void>}
   */
  async prAutoMerge({ pullRequestId, mergeMode, mergeMessage, base }) {
    const octo = octokit(this.token, this.repo);
    const graphql = withCustomRequest(octo.request);
    const { owner, repo } = this.ownerRepo();
    const [commitHeadline, commitBody] = mergeMessage
      ? mergeMessage.split(/\n\n(.*)/s)
      : [];
    const {
      data: { node_id: nodeId }
    } = await octo.pulls.get({ owner, repo, pull_number: pullRequestId });
    try {
      await graphql(
        `
          mutation autoMerge(
            $pullRequestId: ID!
            $mergeMethod: PullRequestMergeMethod
            $commitHeadline: String
            $commitBody: String
          ) {
            enablePullRequestAutoMerge(
              input: {
                pullRequestId: $pullRequestId
                mergeMethod: $mergeMethod
                commitHeadline: $commitHeadline
                commitBody: $commitBody
              }
            ) {
              clientMutationId
            }
          }
        `,
        {
          pullRequestId: nodeId,
          mergeMethod: mergeMode.toUpperCase(),
          commitHeadline,
          commitBody
        }
      );
    } catch (err) {
      const tolerate = [
        "Can't enable auto-merge for this pull request",
        'Pull request Protected branch rules not configured for this branch',
        'Pull request is in clean status'
      ];

      if (!tolerate.some((message) => err.message.includes(message))) throw err;

      const settingsUrl = `https://github.com/${owner}/${repo}/settings`;

      if (await this.isProtected({ branch: base })) {
        winston.warn(
          `Failed to enable auto-merge: Enable the feature in your repository settings: ${settingsUrl}#merge_types_auto_merge. Trying to merge immediately...`
        );
      } else {
        winston.warn(
          `Failed to enable auto-merge: Set up branch protection and add "required status checks" for branch '${base}': ${settingsUrl}/branches. Trying to merge immediately...`
        );
      }

      await octo.pulls.merge({
        owner,
        repo,
        pull_number: pullRequestId,
        merge_method: mergeMode,
        commit_title: commitHeadline,
        commit_message: commitBody
      });
    }
  }

  async prCommentCreate(opts = {}) {
    const { report: body, prNumber } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { issues } = octokit(this.token, this.repo);

    const {
      data: { html_url: htmlUrl }
    } = await issues.createComment({
      owner,
      repo,
      body,
      issue_number: prNumber
    });

    return htmlUrl;
  }

  async prCommentUpdate(opts = {}) {
    const { report: body, id } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { issues } = octokit(this.token, this.repo);

    const {
      data: { html_url: htmlUrl }
    } = await issues.updateComment({
      owner,
      repo,
      body,
      comment_id: id
    });

    return htmlUrl;
  }

  async prComments(opts = {}) {
    const { prNumber } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { issues } = octokit(this.token, this.repo);

    const { data: comments } = await issues.listComments({
      owner,
      repo,
      issue_number: prNumber
    });

    return comments.map(({ id, body }) => {
      return { id, body };
    });
  }

  async prs(opts = {}) {
    const { state = 'open' } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { pulls } = octokit(this.token, this.repo);

    const { data: prs } = await pulls.list({
      owner,
      repo,
      state
    });

    return prs.map((pr) => {
      const {
        html_url: url,
        head: { ref: source },
        base: { ref: target }
      } = pr;
      return {
        url,
        source: branchName(source),
        target: branchName(target)
      };
    });
  }

  async pipelineRerun(opts = {}) {
    const { id = GITHUB_RUN_ID } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { actions } = octokit(this.token, this.repo);

    const {
      data: { status }
    } = await actions.getWorkflowRun({
      owner,
      repo,
      run_id: id
    });

    if (status !== 'running') {
      await actions.reRunWorkflow({
        owner,
        repo,
        run_id: id
      });
    }
  }

  async pipelineRestart(opts = {}) {
    const { jobId } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { actions } = octokit(this.token, this.repo);

    const {
      data: { run_id: runId }
    } = await actions.getJobForWorkflowRun({
      owner,
      repo,
      job_id: jobId
    });

    const {
      data: { status }
    } = await actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId
    });

    if (status !== 'running') {
      try {
        await actions.reRunWorkflow({
          owner,
          repo,
          run_id: runId
        });
      } catch (err) {}
    }
  }

  async pipelineJobs(opts = {}) {
    const { jobs: runnerJobs } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const { actions } = octokit(this.token, this.repo);

    const jobs = await Promise.all(
      runnerJobs.map(async (job) => {
        const { data } = await actions.getJobForWorkflowRun({
          owner,
          repo,
          job_id: job.id
        });

        return data;
      })
    );

    return jobs.map((job) => {
      const { id, started_at: date, run_id: runId, status } = job;
      return { id, date, runId, status };
    });
  }

  async job(opts = {}) {
    const { time, runnerId } = opts;
    const { owner, repo } = ownerRepo({ uri: this.repo });
    const octokitClient = octokit(this.token, this.repo);

    let { status = 'queued' } = opts;
    if (status === 'running') status = 'in_progress';

    const workflowRuns = await octokitClient.paginate(
      octokitClient.actions.listWorkflowRunsForRepo,
      { owner, repo, status }
    );

    let runJobs = await Promise.all(
      workflowRuns.map(
        async ({ id }) =>
          await octokitClient.paginate(
            octokitClient.actions.listJobsForWorkflowRun,
            { owner, repo, run_id: id, status }
          )
      )
    );

    runJobs = [].concat.apply([], runJobs).map((job) => {
      const { id, started_at: date, run_id: runId, runner_id: runnerId } = job;
      return { id, date, runId, runnerId };
    });

    if (time) {
      const job = runJobs.reduce((prev, curr) => {
        const diffTime = (job) => Math.abs(new Date(job.date).getTime() - time);
        return diffTime(curr) < diffTime(prev) ? curr : prev;
      });

      return job;
    }

    return runJobs.find((job) => runnerId === job.runnerId);
  }

  async updateGitConfig({ userName, userEmail } = {}) {
    const repo = new URL(this.repo);
    repo.password = this.token;
    repo.username = 'token';

    const command = `
    git config --unset http.https://github.com/.extraheader;
    git config user.name "${userName || this.userName}" &&
    git config user.email "${userEmail || this.userEmail}" &&
    git remote set-url origin "${repo.toString()}${
      repo.toString().endsWith('.git') ? '' : '.git'
    }"`;

    return command;
  }

  get sha() {
    if (GITHUB_EVENT_NAME === 'pull_request')
      return github.context.payload.pull_request.head.sha;

    return GITHUB_SHA;
  }

  get branch() {
    return branchName(GITHUB_HEAD_REF || GITHUB_REF);
  }

  get userEmail() {
    return 'action@github.com';
  }

  get userName() {
    return 'GitHub Action';
  }
}

module.exports = Github;
