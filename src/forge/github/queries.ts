// GraphQL documents for the GitHub client. Everything the review needs in one
// query per page, and one mutation per action. Kept as plain strings so the
// client and its tests read the same text.

const REVIEW_FIELDS = 'id state submittedAt body url author { login avatarUrl }'
const COMMENT_FIELDS = 'id body createdAt url author { login avatarUrl }'

export const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      title
      body
      url
      isDraft
      state
      merged
      author { login avatarUrl }
      baseRefName
      baseRefOid
      headRefName
      headRefOid
      commits(last: 100) {
        totalCount
        nodes {
          commit {
            oid
            messageHeadline
            committedDate
            author { name user { login avatarUrl } }
            statusCheckRollup { state }
          }
        }
      }
      reviews(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REVIEW_FIELDS} }
      }
      comments(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}`

/** The pages after the first of each connection the PR query opens. */
export const REVIEWS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REVIEW_FIELDS} }
      }
    }
  }
}`

export const COMMENTS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}`

export const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          comments(first: 100) {
            nodes {
              id
              body
              createdAt
              url
              author { login avatarUrl }
            }
          }
        }
      }
    }
  }
}`

export const ADD_REVIEW = `
mutation($pullRequestId: ID!, $commitOID: GitObjectID) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) {
    pullRequestReview { id }
  }
}`

export const ADD_THREAD = `
mutation($reviewId: ID!, $path: String!, $body: String!, $line: Int, $side: DiffSide,
         $startLine: Int, $startSide: DiffSide, $subjectType: PullRequestReviewThreadSubjectType) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $reviewId, path: $path, body: $body, line: $line, side: $side,
    startLine: $startLine, startSide: $startSide, subjectType: $subjectType
  }) {
    thread { id comments(first: 1) { nodes { id url } } }
  }
}`

export const ADD_THREAD_REPLY = `
mutation($reviewId: ID, $threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewId: $reviewId, pullRequestReviewThreadId: $threadId, body: $body
  }) {
    comment { id url }
  }
}`

export const ADD_COMMENT = `
mutation($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge { node { id url } }
  }
}`

export const RESOLVE_THREAD = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`

export const UNRESOLVE_THREAD = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`

export const SUBMIT_REVIEW = `
mutation($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
    pullRequestReview { id url }
  }
}`
