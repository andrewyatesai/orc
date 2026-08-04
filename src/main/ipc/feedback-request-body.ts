import {
  appendFeedbackImagesToFormData,
  type FeedbackImageAttachment
} from './feedback-image-attachments'

const DIAGNOSTIC_BUNDLE_CONTENT_TYPE = 'application/x-ndjson'

export type FeedbackSubmissionType = 'feedback' | 'crash'

export type FeedbackDiagnosticBundleAttachment = {
  bundleSubmissionId: string
  content: string
  bytes: number
  spanCount: number
}

export type FeedbackSubmitBody = {
  feedback: string
  submissionType: FeedbackSubmissionType
  githubLogin: string | null
  githubEmail: string | null
  appVersion: string
  platform: NodeJS.Platform
  osRelease: string
  arch: string
  diagnosticBundle?: FeedbackDiagnosticBundleAttachment
  images?: FeedbackImageAttachment[]
}

/** JSON for a plain report; multipart once a diagnostic bundle or images ride along. */
export function feedbackRequestBodyInit(
  body: FeedbackSubmitBody
): Pick<RequestInit, 'body' | 'headers'> {
  if (!body.diagnosticBundle && !body.images?.length) {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  }

  const formData = new FormData()
  appendFeedbackFormField(formData, 'feedback', body.feedback)
  appendFeedbackFormField(formData, 'submissionType', body.submissionType)
  appendFeedbackFormField(formData, 'githubLogin', body.githubLogin)
  appendFeedbackFormField(formData, 'githubEmail', body.githubEmail)
  appendFeedbackFormField(formData, 'appVersion', body.appVersion)
  appendFeedbackFormField(formData, 'platform', body.platform)
  appendFeedbackFormField(formData, 'osRelease', body.osRelease)
  appendFeedbackFormField(formData, 'arch', body.arch)
  if (body.diagnosticBundle) {
    appendFeedbackFormField(
      formData,
      'diagnosticBundleSubmissionId',
      body.diagnosticBundle.bundleSubmissionId
    )
    appendFeedbackFormField(formData, 'diagnosticBundleBytes', String(body.diagnosticBundle.bytes))
    appendFeedbackFormField(
      formData,
      'diagnosticBundleSpanCount',
      String(body.diagnosticBundle.spanCount)
    )
    formData.append(
      'diagnosticBundleFile',
      new Blob([body.diagnosticBundle.content], { type: DIAGNOSTIC_BUNDLE_CONTENT_TYPE }),
      `orca-diagnostics-${body.diagnosticBundle.bundleSubmissionId}.ndjson`
    )
  }
  appendFeedbackImagesToFormData(formData, body.images ?? [])

  // Why: multipart avoids JSON-escaping a near-cap NDJSON bundle over the
  // backend request limit while still submitting one feedback request.
  return { body: formData }
}

function appendFeedbackFormField(formData: FormData, key: string, value: string | null): void {
  if (value !== null) {
    formData.append(key, value)
  }
}
