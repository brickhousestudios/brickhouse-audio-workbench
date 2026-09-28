import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
const producerFlow = readFileSync(new URL('../app/components/producer-loop-flow.tsx', import.meta.url), 'utf8')
const producerSurface = readFileSync(new URL('../app/components/producer-surface.tsx', import.meta.url), 'utf8')
const globals = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
const destinationStart = page.indexOf('<details className="panel destinationPanel foldSection"')
const destinationEnd = page.indexOf('<details className="studioExtensions systemDetails">')
const destinationPanel = destinationStart >= 0 && destinationEnd > destinationStart
  ? page.slice(destinationStart, destinationEnd)
  : ''
const producerDeliveryEnd = page.indexOf('<details className="advancedBlock"', destinationStart)
const producerDeliveryPanel = destinationStart >= 0 && producerDeliveryEnd > destinationStart
  ? page.slice(destinationStart, producerDeliveryEnd)
  : ''
const deliveryFnsStart = page.indexOf('async function verifyAudiotoolDestination')
const deliveryFnsEnd = page.indexOf('webMcpActionsRef.current')
const deliveryFns = deliveryFnsStart >= 0 && deliveryFnsEnd > deliveryFnsStart
  ? page.slice(deliveryFnsStart, deliveryFnsEnd)
  : ''

const indexOfRequired = (text) => {
  const index = page.indexOf(text)
  assert.notEqual(index, -1, `missing UI marker: ${text}`)
  return index
}

test('producer hierarchy leads with My Sound -> intent -> audition -> tools -> versions -> Audiotool, then technical details', () => {
  const source = indexOfRequired('<span className="kicker">MY SOUND</span>')
  const intent = indexOfRequired('<span className="kicker">WHAT ARE WE MAKING?</span>')
  const library = indexOfRequired('id="audition"')
  const tools = indexOfRequired('id="tools"')
  const results = indexOfRequired('id="versions"')
  const audiotool = indexOfRequired('<span className="kicker">AUDIOTOOL</span>')
  const details = indexOfRequired('className="flowDetails"')
  const nodes = indexOfRequired('<ProducerLoopFlow')
  const secondary = indexOfRequired('MORE AUDIO TOOLS')
  const system = indexOfRequired('System details')
  assert.ok(source < intent && intent < library && library < tools && tools < results && results < audiotool && audiotool < details && details < nodes && nodes < secondary && secondary < system)
})

test('local file loading is an alternate source path rather than the primary source context', () => {
  const sourceStart = page.indexOf('<section className="panel sourcePanel instrumentStrip"')
  const intentStart = page.indexOf('<section className="panel intentPanel instrumentStrip"', sourceStart)
  assert.ok(sourceStart >= 0 && intentStart > sourceStart)
  const sourcePanel = page.slice(sourceStart, intentStart)
  assert.match(sourcePanel, /<CustomPlayer/)
  assert.match(sourcePanel, /className="sourceAlternate"/)
  assert.match(sourcePanel, /Use a local file instead/)
  assert.doesNotMatch(sourcePanel, /AUDIOTOOL PROJECT/)
})

test('primary actions are not labeled optional tools', () => {
  assert.doesNotMatch(page, /OPTIONAL TOOLS/)
  assert.match(page, /Split Stems/)
  assert.match(page, /Analyze Deeper/)
  assert.match(page, /<strong id="tools-heading">Shape it<\/strong>/)
  assert.match(page, /className="tool-tray"/)
})



test('producer surface keeps the ear-work permanent and progressively discloses secondary workflow controls', () => {
  assert.match(page, /<section className="panel sourcePanel instrumentStrip" id="sound"/)
  assert.match(page, /<section className="panel intentPanel instrumentStrip" id="make"/)
  assert.match(page, /<section className="panel libraryPanel auditionWorkspace" id="audition"/)
  assert.match(page, /const showContextTools = hasMeaningfulSelection \|\| Boolean\(activeOperation\)/)
  assert.match(page, /<details className="panel toolsPanel foldSection" id="tools" open=\{Boolean\(activeOperation\)\}>/)
  assert.match(page, /<details className="panel resultsPanel foldSection" id="versions">/)
  assert.match(page, /<details className="panel destinationPanel foldSection" open=\{Boolean\(/)
  assert.match(page, /className="flowDetails"/)
  assert.match(page, /className="secondaryTools"/)
  assert.match(page, /className="studioExtensions systemDetails"/)
})

test('existing shared session hydrates when the page opens', () => {
  assert.match(page, /void refreshSharedSession\(\)/)
  assert.match(page, /sharedSession\?\.source/)
})

test('a privately staged shared source can run a primary action without another upload', () => {
  assert.match(page, /const hasRunnableSource = Boolean\(sourceFile \|\| \(sharedSession\?\.sourceAvailability === "staged" && sharedSession\?\.stagedSourceArtifactId\)\)/)
  assert.match(page, /current\.sourceAvailability === "staged" \? current\.stagedSourceArtifactId/)
})

test('Producer Library keeps Play Next More Keep Bundle Choose behavior in one continuous audition workspace', () => {
  assert.match(page, /<section className="panel libraryPanel auditionWorkspace" id="audition"/)
  assert.match(page, /<strong id="audition-heading">Choose by ear<\/strong>/)
  assert.match(page, /\/api\/audio\/candidates\/\$\{page\}/)
  assert.match(page, /\/api\/audio\/library\/\$\{action\}/)
  assert.match(page, /\/api\/audio\/library\/choose/)
  assert.match(page, /\/api\/audio\/library\/bundle\/\$\{action\}/)
  assert.match(page, /className="bundleRail"/)
  assert.match(page, /activeBundle/)
  assert.match(page, /bundleCandidateIds/)
  assert.match(page, /ready to review together/)
  assert.match(page, /\/api\/audio\/library\/candidates\/\$\{candidate\.providerId\}\/preview/)
  assert.match(page, /className="btn btn-primary deck-next"/)
  assert.match(page, />Next<\/button>/)
  assert.match(page, /className="deck-more"/)
  assert.match(page, />More choices<\/button>/)
  assert.doesNotMatch(page, /<p className="deck-status"/)
  assert.match(page, /candidate\.candidateId === selectedCandidateId/)
  assert.match(page, /Drop original file to A\/B preview/)
  assert.doesNotMatch(producerSurface, /className="intent-label"/)
  assert.match(producerSurface, /Private to you — nothing sent yet/)
  assert.doesNotMatch(page, /onClick=\{playDeckTarget\}/)
  assert.doesNotMatch(page, /onClick=\{holdDeckTarget\}/)
  assert.match(producerSurface, /className=\{`cand-hold\$\{held \? " is-held" : ""\}`\}/)
  assert.match(producerSurface, /Keep \$\{candidate\.title\}/)
  assert.match(producerSurface, /Remove \$\{candidate\.title\} from kept sounds/)
  assert.match(producerSurface, />Kept<\/strong>/)
  assert.match(producerSurface, /\+ Bundle/)
  assert.match(producerSurface, /In Bundle/)
  assert.match(producerSurface, /className="cand-selected" role="status"/)
  assert.match(producerSurface, />Selected ✓<\/span>/)
  assert.match(producerSurface, />Use This<\/button>/)
  assert.match(producerSurface, /aria-label=\{`Selected \$\{candidate\.title\}`\}/)
  assert.match(producerSurface, /const actionLabel = playing \? `Pause \$\{audioLabel\}` : `Play \$\{audioLabel\}`/)
  assert.match(page, /Staging it as the source\. Nothing is sent\./)
  assert.match(page, /playbackEpoch/)
  assert.match(page, /libraryAudioRefs/)
  assert.match(page, /Playback is ready\. Press Play on the active choice to hear it\./)
  assert.doesNotMatch(page, /requires a click before agent-triggered audio/)
  const libraryStart = page.indexOf('<section className="panel libraryPanel auditionWorkspace"')
  const resultsStart = page.indexOf('<details className="panel resultsPanel foldSection"', libraryStart)
  assert.ok(libraryStart >= 0 && resultsStart > libraryStart)
  const libraryPanel = page.slice(libraryStart, resultsStart)
  assert.doesNotMatch(libraryPanel, /Confirm Send/)
  assert.doesNotMatch(libraryPanel, /\/api\/audio\/audiotool\/delivery\/confirm/)
  assert.doesNotMatch(libraryPanel, /undoAudiotoolDelivery/)
})

test('shared session polling reflects MCP Library state even when no local file is loaded', () => {
  const pollStart = page.indexOf('const refresh = async () => {')
  const pollEnd = page.indexOf('async function selectSharedArtifact', pollStart)
  assert.ok(pollStart >= 0 && pollEnd > pollStart)
  const pollBlock = page.slice(pollStart, pollEnd)
  assert.doesNotMatch(pollBlock, /if \(!sourceFile/)
  assert.match(pollBlock, /fetch\("\/api\/audio\/session"/)
  assert.match(pollBlock, /sourceFile && session\.pendingRequest\?\.status === "pending"/)
})

test('stem results expose real in-page audio previews before delivery', () => {
  assert.match(producerSurface, /<audio/)
  assert.match(page, /<CustomPlayer/)
  assert.match(page, /layout="mini"/)
  assert.match(producerSurface, /aria-label=\{actionLabel\}/)
  assert.match(producerSurface, /aria-label=\{`Seek \$\{audioLabel\}`\}/)
  assert.match(producerSurface, /aria-hidden="true"/)
  assert.match(page, /if \(lower\.includes\("vocals"\)\) return "Vocals"/)
  assert.match(page, /if \(lower\.includes\("instrumental"\)\) return "Instrumental"/)
  assert.match(page, /\/api\/audio\/artifacts\/.*\/preview/)
})

test('Audiotool delivery is project-generic human review with exact A3 confirm body', () => {
  assert.ok(destinationPanel)
  assert.match(destinationPanel, /NOT SENT/)
  assert.match(destinationPanel, /Prepare review/)
  assert.match(destinationPanel, /Confirm Send/)
  assert.match(destinationPanel, /Verify project/)
  assert.match(destinationPanel, /Clear destination/)
  assert.match(destinationPanel, /OUTCOME UNKNOWN — reconcile before retry/)
  assert.match(destinationPanel, /APPLY IN FLIGHT/)
  assert.match(destinationPanel, /ROLLED_BACK/)
  assert.match(destinationPanel, />Reconcile<\/button>/)
  assert.doesNotMatch(destinationPanel, /Reconcile \/ retry once/)
  assert.match(destinationPanel, /Confirm Bundle Send/)
  assert.match(destinationPanel, /Private BrickHouse artifact/)
  assert.match(destinationPanel, /Technical receipts stay in Advanced/)
  assert.match(destinationPanel, /Connected and verified for this Workbench session/)
  assert.match(destinationPanel, /BUNDLE OUTCOME UNKNOWN/)
  assert.doesNotMatch(producerDeliveryPanel, /track \{member\.receipt\.created\.trackId\}/)
  assert.doesNotMatch(producerDeliveryPanel, /artifactId} · \{member\.sourceSha256/)
  assert.match(page, /Bundle placement evidence/)
  assert.match(destinationPanel, /track \{member\.receipt\.created\.trackId\}/)
  assert.match(destinationPanel, /sha256 \{member\.sourceSha256\}/)
  assert.doesNotMatch(destinationPanel, /lastDelivery/)
  assert.doesNotMatch(destinationPanel, /MINOR_PINE/)
  assert.doesNotMatch(destinationPanel, /Send 2 stems/)
  assert.doesNotMatch(destinationPanel, /Review delivery to Minor Pine/)
  assert.match(deliveryFns, /JSON\.stringify\(\{ expectedRevision: current\.revision, operationId, confirm: true \}\)/)
  assert.match(deliveryFns, /JSON\.stringify\(\{ expectedRevision: current\.revision, receiptId: receipt\.receiptId, confirm: true \}\)/)
  assert.match(deliveryFns, /\/api\/audio\/audiotool\/delivery\/confirm/)
  assert.match(deliveryFns, /\/api\/audio\/audiotool\/bundle\/delivery\/confirm/)
  assert.match(deliveryFns, /\/api\/audio\/audiotool\/bundle\/member\/move/)
  assert.match(deliveryFns, /pendingShape/)
  assert.match(page, /async function moveBundleMemberByBars/)
  assert.match(page, /"−1 bar"/)
  assert.match(page, /"\+1 bar"/)
  assert.match(page, /Reconcile move/)
  assert.match(page, /Moved \{latestShape\.bars/)
  assert.match(globals, /\.bundleShapeActions button \{[^}]*min-height:44px/)
  assert.match(deliveryFns, /\/api\/audio\/audiotool\/delivery\/undo/)
  assert.doesNotMatch(deliveryFns, /localPath/)
  assert.doesNotMatch(deliveryFns, /sourceSha256:/)
  assert.doesNotMatch(page, /lastDelivery/)
})

test('Producer Loop checklist is a first-class live node rail sourced from the authoritative projection', () => {
  assert.match(page, /<ProducerLoopFlow/)
  assert.match(page, /nodes=\{producerLoop\?\.nodes \|\| IDLE_PRODUCER_LOOP_NODES\}/)
  assert.match(page, /\/api\/audio\/producer-loop/)
  assert.match(producerFlow, /const ORDER = \["source", "understand", "artifacts", "select", "destination", "review", "send", "verify", "receipt", "undo"\] as const/)
  for (const label of ['Source', 'Understand', 'Artifacts', 'Select', 'Destination', 'Review', 'Send', 'Verify', 'Receipt', 'Undo']) {
    assert.match(producerFlow, new RegExp(`\\b${label}\\b`))
  }
  assert.match(producerFlow, /producerFlowRail/)
  assert.match(producerFlow, /producerFlowNode/)
  assert.match(producerFlow, /producerFlowConnector/)
  assert.match(producerFlow, /NEEDS_USER/)
  assert.match(producerFlow, /OUTCOME_UNKNOWN/)
  assert.match(page, /ProducerLoopNodeState = "NOT_STARTED" \| "WAITING" \| "RUNNING" \| "NEEDS_USER" \| "VERIFIED" \| "PARTIAL" \| "FAILED_SAFE" \| "OUTCOME_UNKNOWN" \| "ROLLED_BACK"/)
  assert.doesNotMatch(destinationPanel, /className="producerLoop"/)
  assert.match(page, /<ProducerLoopFlow/)
  assert.doesNotMatch(page, /\{producerLoop && <ProducerLoopFlow/)
  assert.match(producerFlow, /is partial/)
  assert.match(producerFlow, /data-status=\{visual\}/)
  assert.match(readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8'), /producerFlowNode\[data-status="attention"\]/)
})

test('Producer Loop rail stays mounted for loading, error, and unverified authority', () => {
  assert.match(page, /producerLoopStatus/)
  assert.match(page, /"loading"/)
  assert.match(page, /"error"/)
  assert.match(page, /"unverified"/)
  assert.match(page, /setProducerLoop\(null\)/)
  assert.match(producerFlow, /Producer Loop is loading/)
  assert.match(producerFlow, /Producer Loop is unverified/)
})

test('Analyze Vocal copy does not claim a separate Audiotool project', () => {
  assert.doesNotMatch(page, /Analyze Vocal may still use its own project/)
})

test('stale human review is visible and refreshable instead of silently looping Confirm Send', () => {
  assert.match(page, /pendingReviewCurrent/)
  assert.match(page, /stalePendingReview/)
  assert.match(page, /REVIEW EXPIRED SAFELY/)
  assert.match(page, /Refresh review/)
  assert.match(page, /Send stopped safely\. Reconcile or refresh the review before continuing\./)
  assert.match(page, /Bundle send stopped safely\. Reconcile or refresh the review before continuing\./)
  assert.doesNotMatch(deliveryFns, /response\.status === 409 \|\| life\?\.status === "APPLY_IN_FLIGHT"/)
})

test('Analyze Vocal uses explicit Audiotool region choice and verified result state without provider branding', () => {
  assert.match(page, /AUDIOTOOL VOCAL ANALYSIS/)
  assert.match(page, /Choose an audio region/)
  assert.match(page, /"Analyze Vocal"/)
  assert.match(page, /ANALYZED_REMOTE_VERIFIED/)
  assert.match(page, /PITCH STABILITY/)
  assert.match(page, /DETECTED NOTES/)
  assert.doesNotMatch(page, />VoiceKit</)
  assert.doesNotMatch(page, />Hugging Face</)
})

test('Ask About Audio is one source-bound conversation with explicit research gating and no model picker', () => {
  assert.match(page, /ASK ABOUT AUDIO/)
  assert.match(page, /Keep one conversation with the exact current source/)
  assert.match(page, /\/api\/audio\/conversation\/ask/)
  assert.match(page, /Allow research-only reasoning for this source/)
  assert.match(page, /non-commercial research analysis/)
  assert.doesNotMatch(page, />Audio Flamingo</)
  assert.doesNotMatch(page, />Music Flamingo</)
  assert.doesNotMatch(page, />Whisper</)
  assert.doesNotMatch(page, /model picker/i)
})

test('research approval resets when shared source hash changes', () => {
  assert.match(page, /researchApprovalSourceHash/)
  assert.match(page, /setResearchAudioApproved\(false\)/)
  assert.match(page, /researchApprovalSourceHash\.current !== nextSourceHash/)
})

test('WebMCP exposes the approved agent surface without bypassing human Audiotool delivery', () => {
  assert.match(page, /modelContext/)
  assert.match(page, /registerTool/)
  assert.match(page, /new AbortController\(\)/)
  assert.match(page, /\.abort\(\)/)

  for (const toolName of [
    'get_audio_workbench_state',
    'list_audio_tools',
    'run_audio_tool',
    'list_audio_artifacts',
    'select_audio_artifact',
    'get_audiotool_delivery_status',
    'start_audiotool_delivery_review',
  ]) {
    assert.match(page, new RegExp(`name:\\s*["']${toolName}["']`), `missing WebMCP tool: ${toolName}`)
  }

  assert.match(page, /enum:\s*\[\s*["']split-stems["']\s*,\s*["']analyze-deeper["']\s*\]/)
  const webMcpStart = page.indexOf('name: "get_audio_workbench_state"')
  const webMcpEnd = page.indexOf('return () => lifecycle.abort()')
  assert.ok(webMcpStart >= 0 && webMcpEnd > webMcpStart, 'WebMCP registration block must be bounded and cleaned up')
  const webMcpBlock = page.slice(webMcpStart, webMcpEnd)
  assert.doesNotMatch(webMcpBlock, /confirmAudiotoolDelivery/)
  assert.doesNotMatch(webMcpBlock, /undoAudiotoolDelivery/)
  assert.doesNotMatch(webMcpBlock, /\/api\/audio\/audiotool\/delivery\/confirm/)
  assert.doesNotMatch(webMcpBlock, /\/api\/audio\/audiotool\/delivery\/undo/)
  assert.doesNotMatch(webMcpBlock, /\/api\/audio\/deliver\/audiotool/)
  assert.doesNotMatch(webMcpBlock, /sendStemsToAudiotool/)
  assert.doesNotMatch(webMcpBlock, /name:\s*["'][^"']*(confirm_|send_|deliver_|apply_|commit_|undo_)/i)
  assert.match(page, /prepareAudiotoolDeliveryReview/)
  assert.match(webMcpBlock, /getDeliveryStatus/)
  assert.match(webMcpBlock, /startDeliveryReview/)
})

test('verified Audiotool delivery exposes human-only compensating undo and durable rollback state', () => {
  assert.match(destinationPanel, /Undo Send/)
  assert.match(deliveryFns, /\/api\/audio\/audiotool\/delivery\/undo/)
  assert.match(destinationPanel, /ROLLED_BACK/)
  assert.match(destinationPanel, /Verified rollback/)
  const webMcpStart = page.indexOf('name: "get_audio_workbench_state"')
  const webMcpEnd = page.indexOf('return () => lifecycle.abort()')
  const webMcpBlock = page.slice(webMcpStart, webMcpEnd)
  assert.doesNotMatch(webMcpBlock, /undoAudiotoolDelivery/)
  assert.doesNotMatch(webMcpBlock, /\/api\/audio\/audiotool\/delivery\/undo/)
})

test('prepareAudiotoolDeliveryReview reuses current Bundle or single pending review before minting its replacement operation', () => {
  const prepareStart = page.indexOf('async function prepareAudiotoolDeliveryReview()')
  const prepareEnd = page.indexOf('async function confirmAudiotoolDelivery()')
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart)
  const prepareBlock = page.slice(prepareStart, prepareEnd)
  assert.match(prepareBlock, /pendingBundleReviewMatchesCurrent\(current\)/)
  assert.match(prepareBlock, /pendingReviewMatchesCurrent\(current\)/)
  assert.match(prepareBlock, /return \{ ok: true, session: current \}/)
  const bundleReuseIndex = prepareBlock.indexOf('pendingBundleReviewMatchesCurrent(current)')
  const firstUuidIndex = prepareBlock.indexOf('crypto.randomUUID()')
  const singleReuseIndex = prepareBlock.indexOf('pendingReviewMatchesCurrent(current)')
  const secondUuidIndex = prepareBlock.indexOf('crypto.randomUUID()', firstUuidIndex + 1)
  assert.ok(bundleReuseIndex >= 0 && firstUuidIndex > bundleReuseIndex, 'reuse current Bundle review before minting a Bundle operation')
  assert.ok(singleReuseIndex >= 0 && secondUuidIndex > singleReuseIndex, 'reuse current single review before minting a single operation')
  assert.match(prepareBlock, /if \(pendingBundleReviewMatchesCurrent\(current\) && current\.pendingBundleDeliveryReview\)/)
  assert.match(prepareBlock, /if \(pendingReviewMatchesCurrent\(current\) && current\.pendingDeliveryReview\)/)
})

test('get_audiotool_delivery_status awaits a fresh Producer Loop read instead of closed-over state', () => {
  const statusStart = page.indexOf('async getDeliveryStatus()')
  const statusEnd = page.indexOf('async startDeliveryReview()')
  assert.ok(statusStart >= 0 && statusEnd > statusStart)
  const statusBlock = page.slice(statusStart, statusEnd)
  assert.match(statusBlock, /await refreshSharedSession\(\)/)
  assert.match(statusBlock, /const freshProducerLoop = await refreshProducerLoop\(\)/)
  assert.match(statusBlock, /producerLoop: freshProducerLoop/)
  assert.doesNotMatch(statusBlock, /producerLoop: producerLoop/)
  assert.match(page, /fetch\("\/api\/audio\/producer-loop"/)
  assert.match(page, /const refreshProducerLoop = useCallback\(async \(\): Promise<ProducerLoopProjection \| null>/)
})

test('Audiotool undo performs a fresh shared-session readback before rendering rollback state', () => {
  const undoStart = page.indexOf('async function undoAudiotoolDelivery()')
  const snapshotStart = page.indexOf('webMcpActionsRef.current')
  assert.ok(undoStart >= 0 && snapshotStart > undoStart)
  const undoBlock = page.slice(undoStart, snapshotStart)
  assert.match(undoBlock, /const verifiedSession = payload\.session/)
  assert.match(undoBlock, /life\?\.status === "ROLLED_BACK"/)
  assert.match(undoBlock, /UNDO_OUTCOME_UNKNOWN/)
})


test('agent-triggered autoplay rejection never labels the candidate PLAYING', () => {
  assert.match(page, /libraryPlaybackBlockedCandidateId/)
  assert.match(page, /setLibraryPlaybackBlockedCandidateId\(state\.activeCandidateId\)/)
  assert.match(producerSurface, /activeCandidateId === candidate\.candidateId && playbackBlockedCandidateId === candidate\.candidateId/)
  assert.match(producerSurface, /Ready — press Play for sound/)
})


test('chosen state becomes the center of gravity: selected dock plus human Review & Send gate', () => {
  assert.match(page, /className=\{hasMeaningfulSelection \? "shell shell-instrument shell-committed" : "shell shell-instrument"\}/)
  assert.match(page, /className="commitBar selectedRail" role="status"/)
  assert.match(page, /Private to you — nothing sent yet/)
  const commitStart = page.indexOf('className="commitBar selectedRail"')
  const commitEnd = page.indexOf('className="panel toolsPanel foldSection"', commitStart)
  assert.ok(commitStart >= 0 && commitEnd > commitStart)
  const commitBlock = page.slice(commitStart, commitEnd)
  assert.match(commitBlock, /Review & Send →/)
  assert.match(commitBlock, /prepareAudiotoolDeliveryReview\(\)/)
  assert.doesNotMatch(commitBlock, /Confirm Send/)
  assert.doesNotMatch(commitBlock, /undoAudiotoolDelivery/)
  assert.match(destinationPanel, /destinationRow deliveryHappy/)
  assert.match(destinationPanel, /Your selected version is staged locally\. Review the destination before sending\./)
  assert.match(destinationPanel, /<strong>\{verifiedDestination \? "Not sent" : "Destination not verified"\}<\/strong>/)
})

test('stale receipts live in Activity & recovery instead of the delivery happy path', () => {
  const recoveryStart = page.indexOf('id="details"')
  const secondaryToolsStart = page.indexOf('className="secondaryTools"')
  assert.ok(recoveryStart >= 0 && secondaryToolsStart > recoveryStart)
  const recoveryBlock = page.slice(recoveryStart, secondaryToolsStart)
  assert.match(recoveryBlock, /Previous placement/)
  assert.match(recoveryBlock, /Receipt \{lifecycle\.receipt\.receiptId\}/)
  assert.match(recoveryBlock, /Undo Send/)
  const happyStart = page.indexOf('className="destinationRow deliveryHappy"')
  const happyEnd = page.indexOf('</>)\}', happyStart)
  const happyBlock = happyStart >= 0 && happyEnd > happyStart ? page.slice(happyStart, happyEnd) : ''
  assert.ok(happyBlock)
  assert.doesNotMatch(happyBlock, /Undo Send/)
  assert.match(happyBlock, /Activity &amp; recovery/)
})


test('desktop producer instrument is a horizontal workstation instead of a vertical feed', () => {
  const selectedRail = page.indexOf('className="commitBar selectedRail"')
  const audition = page.indexOf('<section className="panel libraryPanel auditionWorkspace"')
  assert.ok(selectedRail >= 0 && audition > selectedRail)
  assert.match(globals, /@media \(min-width:1051px\)[\s\S]*?\.shell-instrument \{[\s\S]*?grid-template-columns:minmax\(0,1\.08fr\) minmax\(0,1fr\) minmax\(280px,\.72fr\)/)
  assert.match(globals, /\.shell-instrument \.cand-grid \{[\s\S]*?grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/)
  assert.match(globals, /\.shell-instrument \.toolsPanel \{ grid-column:1; \}/)
  assert.match(globals, /\.shell-instrument \.destinationPanel \{ grid-column:3; \}/)
  assert.match(globals, /\.shell-instrument:not\(:has\(\.resultsPanel\)\) \.advancedBlock/)
})


test('candidate click focuses inside the audition deck while Use This remains the only choose/stage action', () => {
  const deckStart = producerSurface.indexOf('export function AuditionDeck')
  const cardStart = producerSurface.indexOf('export function CandidateCard')
  const deckBlock = producerSurface.slice(deckStart)
  assert.ok(deckStart >= 0 && cardStart >= 0)
  assert.match(deckBlock, /const \[focusedCandidateId, setFocusedCandidateId\] = useState<string \| null>\(null\)/)
  assert.match(deckBlock, /setFocusedCandidateId\(candidate\.candidateId\)/)
  assert.doesNotMatch(deckBlock, /fetch\(/)
  assert.doesNotMatch(deckBlock, /refreshSharedSession/)
  assert.doesNotMatch(deckBlock, /runLibraryAction/)
  assert.doesNotMatch(deckBlock, /chooseLibraryCandidate/)
  assert.match(page, /<AuditionDeck/)
  assert.doesNotMatch(page, /const \[focusedCandidateId, setFocusedCandidateId\]/)
  assert.match(page, /onPlay=\{\(candidateId\) => void runLibraryAction\("play", candidateId\)\}/)
  assert.match(page, /onUse=\{\(candidateId\) => void chooseLibraryCandidate\(candidateId\)\}/)
  assert.match(producerSurface, /onClick=\{onFocusCandidate\}/)
  assert.match(producerSurface, /onFocusCapture=\{onFocusCandidate\}/)
  assert.match(producerSurface, /aria-current=\{focused \? "true" : undefined\}/)
  assert.doesNotMatch(page + producerSurface, /localStorage[\s\S]{0,120}focusedCandidateId/)
})


test('audition Loop is local, one-at-a-time, and wired to the native audio loop attribute', () => {
  const deckStart = producerSurface.indexOf('export function AuditionDeck')
  const deckBlock = producerSurface.slice(deckStart)
  assert.match(deckBlock, /const \[loopingCandidateId, setLoopingCandidateId\] = useState<string \| null>\(null\)/)
  assert.match(deckBlock, /looping=\{loopingCandidateId === candidate\.candidateId\}/)
  assert.match(deckBlock, /onLoopToggle=\{\(\) => setLoopingCandidateId/)
  assert.doesNotMatch(deckBlock, /fetch\(/)
  assert.doesNotMatch(deckBlock, /runLibraryAction\(/)
  assert.match(producerSurface, /loop=\{looping\}/)
  assert.match(producerSurface, /loop=\{loop\}/)
  assert.match(producerSurface, /aria-pressed=\{loop\}/)
})
