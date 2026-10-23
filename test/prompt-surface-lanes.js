/**
 * Capture-lane evidence for the model-visible prompt surface.
 *
 * A channel is "captured" only when a real lane pins the bytes of each anchor it
 * claims: the lane file exists, it reads its expectation from this module, and every
 * captured anchor carries its own evidence — a recorded hash for assembly lanes, or a
 * fragment that must appear in the recorded golden for byte lanes. An anchor the lane
 * cannot reach is listed in `pending` with the reason it is out of reach, and the gate
 * requires that same anchor to be declared in test/prompt-surface-map.js. Claiming an
 * anchor without evidence, or hiding one behind a trivial golden, therefore fails.
 *
 * Regenerating a golden is a deliberate edit: run the lane, read the assertion
 * failure, paste the reported bytes and hash here, and state in the commit why the
 * delivered text changed. Never derive the golden from the run you are testing;
 * that turns the lane into a mirror of the implementation.
 *
 * This module records expectations only. It must not deliver anything: the gate
 * owns delivery through test/prompt-surface-composers.js, because a lane that
 * supplies its own bytes can always satisfy its own hash.
 */
export const LANES = Object.freeze({
  prompt: Object.freeze({
    file: 'test/prompt-surface.test.js',
    kind: 'assembly',
    // Anchors this lane hashes besides the registry-owned ones: the host section the
    // plugin appends into differs from its baseline, and that segment is hashed
    // separately so the appended appendix cannot hide inside a host anchor.
    hostAnchors: Object.freeze(['tools:sdk', 'tools:sdk#capability-appendix']),
    hashes: Object.freeze({
      'tools:ptc-plus-repl': 'f7e2f3a8e066188dc83dc9e7d3171f8e66ff3609f6be079955f4b2c1a7a6f8ca',
      'tools:sdk': '6f99cf22232d754ef6bfdf7feea81936f5be572ddf99c9aee6a4470471fa16fc',
      'tools:sdk#capability-appendix': '1b2937bb8ceccccf66d476c815c3d191402782db67212d21ebda0a4a3a2b9201',
      run_code: '8910d1ca110c66719c28729a09d09c9b3cdf402c2583339e49bcc6f1dc1de810',
    }),
    pending: Object.freeze({
      'tools:ptc-plus-user-binding-defaults':
        'the assembly fixture runs without global bindings, so the section this anchor adds is never assembled there',
    }),
  }),
  install: Object.freeze({
    file: 'test/prompt-surface.test.js',
    kind: 'install',
    hashes: Object.freeze({
      edit_run_code: '39caa9aef96e2b976ceac1d2e049767bc34242c28ae80c81e7d89267e62235a2',
    }),
    pending: Object.freeze({}),
  }),
  plan: Object.freeze({
    file: 'test/prompt-surface-plan.test.js',
    kind: 'bytes',
    // Each captured anchor names a fragment the delivered text must contain: a golden
    // that does not carry the fragment cannot vouch for that anchor. The fixture defers
    // one contract (so a category line is composed) and selects another as a full
    // contract over a 16-byte budget (so the overage sentence is delivered), which is
    // what lets the lane cover the whole plan instead of its navigation paragraph.
    captured: Object.freeze({
      'plan.navigation': Object.freeze({
        fragment: 'Use capabilities.search({query}) to retrieve complete tool, Skill and MCP contracts. '
          + 'Unlisted capabilities remain discoverable. Skill descriptions are summaries; follow each '
          + "Skill's declared invocation eligibility to load its body before following it.",
      }),
      'plan.categories': Object.freeze({
        fragment: 'Tools: search by task or tools.<name> for parameters and results.',
      }),
      'plan.overage': Object.freeze({
        fragment: 'Explicit full contracts exceed the configured budget by 104 UTF-8 bytes.',
      }),
    }),
    pending: Object.freeze({}),
    // No `deliver` here on purpose: delivery belongs to test/prompt-surface-composers.js,
    // which the gate imports itself. An evidence file that supplies bytes can always
    // satisfy its own hash, so the gate asserts this field is absent.
    golden: Object.freeze({
      text: 'PTC Plus session capability environment:\n\n'
        + 'Use capabilities.search({query}) to retrieve complete tool, Skill and MCP contracts. '
        + 'Unlisted capabilities remain discoverable. Skill descriptions are summaries; follow each '
        + "Skill's declared invocation eligibility to load its body before following it.\n"
        + 'Tools: search by task or tools.<name> for parameters and results.\n\n'
        + '### tools.probe\n```ts\n/** Owner contract for probe. */\n'
        + 'tools.probe(args: Record<string, JsonValue>): Promise<string>\n```\n\n'
        + 'Explicit full contracts exceed the configured budget by 104 UTF-8 bytes.',
      hash: '4d396c63aacc34e2087d671cb877712e084655cc99c78d5596897ffd2881818f',
    }),
  }),
})
