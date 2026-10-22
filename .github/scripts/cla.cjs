// CLA check for pull requests, run by .github/workflows/cla.yml through actions/github-script.
//
// The author of a pull request and every commit author must either be on the allowlist or have signed CLA.md.
// A contributor signs by commenting SIGN_PHRASE on the pull request; the signature is stored in
// signatures.json on the SIGNATURE_BRANCH. The result is reported as the commit status "CLA" on the
// pull request's head commit and in one bot comment that is updated in place.
//
// Runs on pull_request_target and issue_comment, i.e. with a write token: never check out or run
// code from the pull request here.

const SIGNATURE_BRANCH = 'cla-signatures'
const SIGNATURE_FILE = 'signatures.json'
const CLA_FILE = 'CLA.md'
const SIGN_PHRASE = 'I have read the CLA and I hereby sign it.'
const RECHECK_PHRASE = 'recheck'
const ALLOWLIST = ['dominiktilman', 'lasselung']
const STATUS_CONTEXT = 'CLA'
const COMMENT_MARKER = '<!-- eml-cla-check -->'

const normalize = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase()

// A commit author's name is free text: as a code span it can't mention anyone or carry Markdown.
const codeSpan = (text) => `\`${String(text).replace(/[`\r\n]/g, "'")}\``

const isAllowed = (login) => ALLOWLIST.includes(login) || login.endsWith('[bot]')

async function readSignatures(github, repo) {
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path: SIGNATURE_FILE, ref: SIGNATURE_BRANCH })
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'))
    return { signatures: parsed.signatures, sha: data.sha }
  } catch (error) {
    if (error.status === 404) return { signatures: [], sha: undefined }
    throw error
  }
}

async function ensureSignatureBranch(github, repo) {
  try {
    await github.rest.git.getRef({ ...repo, ref: `heads/${SIGNATURE_BRANCH}` })
  } catch (error) {
    if (error.status !== 404) throw error
    const { data: info } = await github.rest.repos.get(repo)
    const { data: base } = await github.rest.git.getRef({ ...repo, ref: `heads/${info.default_branch}` })
    await github.rest.git.createRef({ ...repo, ref: `refs/heads/${SIGNATURE_BRANCH}`, sha: base.object.sha })
  }
}

async function claVersion(github, repo) {
  const { data: info } = await github.rest.repos.get(repo)
  const { data } = await github.rest.repos.getContent({ ...repo, path: CLA_FILE, ref: info.default_branch })
  return data.sha
}

// Who has to sign for a pull request: the account that opened it — commits can carry anyone's
// linked e-mail, so the authors alone don't say who submits the work — and every commit author,
// plus the authors whose e-mail is not linked to a GitHub account.
async function contributors(github, repo, pull) {
  const commits = await github.paginate(github.rest.pulls.listCommits, { ...repo, pull_number: pull.number, per_page: 100 })
  const logins = new Map([[pull.user.login, pull.user.id]])
  const unlinked = new Set()
  for (const commit of commits) {
    if (commit.author?.login) logins.set(commit.author.login, commit.author.id)
    else unlinked.add(commit.commit.author.name)
  }
  return { logins, unlinked: [...unlinked] }
}

// Updates the bot comment, or creates it unless onlyUpdate (a passing check needs no new comment).
async function upsertComment(github, repo, pullNumber, body, onlyUpdate) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: pullNumber, per_page: 100 })
  const existing = comments.find((comment) => comment.body?.includes(COMMENT_MARKER))
  const text = `${COMMENT_MARKER}\n${body}`
  if (existing) await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body: text })
  else if (!onlyUpdate) await github.rest.issues.createComment({ ...repo, issue_number: pullNumber, body: text })
}

async function check(github, context, core, pullNumber) {
  const repo = context.repo
  const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: pullNumber })
  const { signatures } = await readSignatures(github, repo)
  const signed = new Set(signatures.map((signature) => signature.id))
  const { logins, unlinked } = await contributors(github, repo, pull)
  const missing = [...logins].filter(([login, id]) => !isAllowed(login) && !signed.has(id)).map(([login]) => login)

  const ok = missing.length === 0 && unlinked.length === 0
  await github.rest.repos.createCommitStatus({
    ...repo,
    sha: pull.head.sha,
    state: ok ? 'success' : 'failure',
    context: STATUS_CONTEXT,
    description: ok ? 'All contributors have signed the CLA' : 'Contributors still need to sign the CLA',
  })

  const claUrl = `https://github.com/${repo.owner}/${repo.repo}/blob/${pull.base.repo.default_branch}/${CLA_FILE}`
  let body
  if (ok) {
    body = 'All contributors have signed the [Contributor License Agreement](' + claUrl + '). Thank you.'
  } else {
    const lines = [
      `Thank you for your contribution. Before we can merge it, the author of this pull request and every commit author need to sign our [Contributor License Agreement](${claUrl}).`,
      '',
      'To sign, read the agreement and post this comment on this pull request:',
      '',
      '```',
      SIGN_PHRASE,
      '```',
      '',
    ]
    if (missing.length) lines.push(`Not signed yet: ${missing.map((login) => `@${login}`).join(', ')}`)
    if (unlinked.length) {
      lines.push(
        `Commits by ${unlinked.map(codeSpan).join(', ')} use an e-mail address that is not linked to a GitHub account. ` +
          'Link the address to your account or rewrite the commits with a linked address, then comment `recheck`.',
      )
    }
    body = lines.join('\n')
  }
  await upsertComment(github, repo, pullNumber, body, ok)
  core.info(ok ? 'CLA check passed' : `CLA check failed: missing ${missing.join(', ')}; unlinked ${unlinked.join(', ')}`)
}

async function sign(github, context, core, pullNumber) {
  const repo = context.repo
  const commenter = context.payload.comment.user
  const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: pullNumber })
  const { logins } = await contributors(github, repo, pull)
  if (!logins.has(commenter.login)) {
    core.info(`${commenter.login} is not a contributor of #${pullNumber}; nothing to sign`)
    return
  }
  await ensureSignatureBranch(github, repo)
  const version = await claVersion(github, repo)
  // A signature from another pull request can land between read and write (409/422 on a stale sha):
  // read again and retry.
  for (let attempt = 1; ; attempt++) {
    const { signatures, sha } = await readSignatures(github, repo)
    if (signatures.some((signature) => signature.id === commenter.id)) return
    signatures.push({
      login: commenter.login,
      id: commenter.id,
      signed_at: context.payload.comment.created_at,
      cla_version: version,
      pull_request: pullNumber,
      comment_url: context.payload.comment.html_url,
    })
    try {
      await github.rest.repos.createOrUpdateFileContents({
        ...repo,
        path: SIGNATURE_FILE,
        branch: SIGNATURE_BRANCH,
        sha,
        message: `CLA signed by @${commenter.login} in #${pullNumber}`,
        content: Buffer.from(`${JSON.stringify({ signatures }, null, 2)}\n`).toString('base64'),
      })
      return
    } catch (error) {
      if (attempt >= 3 || (error.status !== 409 && error.status !== 422)) throw error
    }
  }
}

module.exports = async ({ github, context, core }) => {
  if (context.eventName === 'pull_request_target') {
    await check(github, context, core, context.payload.pull_request.number)
    return
  }
  if (context.eventName === 'issue_comment' && context.payload.issue.pull_request) {
    const text = normalize(context.payload.comment.body ?? '')
    const pullNumber = context.payload.issue.number
    if (text === normalize(SIGN_PHRASE)) {
      await sign(github, context, core, pullNumber)
      await check(github, context, core, pullNumber)
    } else if (text === RECHECK_PHRASE) {
      await check(github, context, core, pullNumber)
    }
  }
}
