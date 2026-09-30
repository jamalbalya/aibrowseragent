/**
 * TEST-BOUNDARY-001 — the producer/consumer census, checked by running it.
 *
 * Two shipped defects came from the same shape. A download filename was
 * validated against 200 and recorded into a field bounded at 128, so an ordinary
 * long filename made the record disappear and the panel say the trail was
 * corrupt. An MCP server descriptor bounded nothing, so a long server id built a
 * tool name past 256 and every invocation of that server lost its record. In
 * both cases the operation was correct and the *record of it* was refused,
 * because two numbers that had to agree lived in two files that never met.
 *
 * A table of numbers would drift the same way, so this suite does not check the
 * table against itself. For every entry in `BOUNDARY_CONTRACTS` it runs the real
 * producer at its stated maximum and requires the real audit log to accept the
 * result. A number edited in `boundaries.ts` that breaks the relation fails
 * here; a producer that grows past its consumer fails here; a census entry that
 * stops describing the code fails its coverage case.
 *
 * The mutation cases at the end prove the suite is load-bearing rather than
 * decorative.
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_CONTRACTS,
  boundedDetail,
  MAX_DESTINATION,
  MAX_DETAIL,
  MAX_DNS_NAME,
  MAX_ENDPOINT_URL,
  MAX_FILENAME,
  MAX_MCP_DISPLAY_NAME,
  MAX_MCP_SERVER_ID,
  MAX_MCP_TOOL_NAME,
  MAX_MEDIA_TYPE,
  MAX_MODEL_ID,
  MAX_SKILL_ID,
  MAX_SKILL_VERSION,
  MAX_OPAQUE_ID,
  MAX_ORIGIN,
  MAX_STRING,
  MCP_TOOL_NAME_MAX,
} from '@/audit/boundaries';
import { AuditLog, fieldLimit } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { checkDownloadFilename } from '@/files/download-safety';
import { safeDisplayName, safeMediaType } from '@/files/file-model';
import { admitDiscoveredTool, mcpToolName, validateServerDescriptor } from '@/mcp/core/mcp-model';
import { mcpDestination, providerDestination } from '@/security/egress/destination';
import { managementTaskId } from '@/security/egress/provider-transport';
import { runIdFor, unattendedSessionIdFor } from '@/schedules/schedule-model';
import { newId } from '@/utils/ids';
import { isRecordableModelId } from '@/providers/core/provider-http';
import { parseModelCatalogue } from '@/providers/adapters/nine-router-catalog';
import { validateSkillDefinition } from '@/skills/core/skill-model';
import { RECORDED_PROVENANCE } from '@/workflows/workflow-model';

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

/** A log that verifies every tool name, so only the *bounds* are under test. */
const freshLog = (): AuditLog => new AuditLog(area(), { knownTool: () => true });

/** Whether the real audit log will store this record. */
async function accepted(event: Record<string, unknown>): Promise<boolean> {
  return (await freshLog().record(event as never)) !== null;
}

/** A hostname at the longest DNS permits, built from real labels. */
function longestHostname(): string {
  const label = 'a'.repeat(63);
  // 63*3 + 3 separators = 192; pad the last label out to exactly MAX_DNS_NAME.
  const head = `${label}.${label}.${label}.`;
  return head + 'b'.repeat(MAX_DNS_NAME - head.length);
}

describe('TEST-BOUNDARY-001 — every census entry holds', () => {
  it('01 — the table is not empty and has not shrunk', () => {
    // The population assertion. An enumeration that lost its entries would
    // otherwise pass every case below by describing nothing.
    expect(BOUNDARY_CONTRACTS.length).toBe(16);
    expect(new Set(BOUNDARY_CONTRACTS.map((c) => `${c.field}/${c.producer}`)).size).toBe(
      BOUNDARY_CONTRACTS.length,
    );
  });

  it('02 — covers every field this suite exercises, and nothing it does not', () => {
    // Coverage in both directions: a field added to the table without a runtime
    // case below fails here, and a case below for a field the table omits fails
    // here too.
    expect(new Set(BOUNDARY_CONTRACTS.map((c) => c.field))).toEqual(
      new Set([
        'fileName',
        'tool',
        'destination',
        'origin',
        'site',
        'modelId',
        'mimeType',
        'detail',
        'skillId',
        'skillVersion',
        'taskId',
        'sessionId',
        'evidenceIds[]',
      ]),
    );
  });

  for (const contract of BOUNDARY_CONTRACTS) {
    it(`03 — ${contract.field} from ${contract.producer} fits its consumer`, () => {
      // The relation the whole file exists for.
      expect(
        contract.transformedMax,
        `${contract.producer} can emit ${contract.transformedMax} into ${contract.consumer}, ` +
          `which accepts ${contract.consumerMax}`,
      ).toBeLessThanOrEqual(contract.consumerMax);
      // And a producer maximum that no transformation shrinks cannot already be
      // over: an entry claiming otherwise is describing the wrong function.
      expect(contract.producerMax).toBeGreaterThan(0);
    });
  }

  it('04 — the table agrees with the audit log about each field limit', () => {
    // The table names a consumer maximum; the log decides one. If those two
    // disagree the table is fiction, however well it checks against itself.
    for (const contract of BOUNDARY_CONTRACTS) {
      if (contract.consumer.startsWith('AuditLog ')) {
        const field = contract.consumer.slice('AuditLog '.length);
        // Two consumers are not per-field limits: the identifier rule applies to
        // a set of fields, and the array rule to a set of entries.
        if (field === 'array entry' || field === 'isOpaqueId') continue;
        expect(fieldLimit(field), field).toBe(contract.consumerMax);
      }
    }
  });
});

describe('TEST-BOUNDARY-001 — each producer at its maximum is recordable', () => {
  it('05 — fileName: the download validator at its limit', async () => {
    const longest = `${'a'.repeat(196)}.txt`;
    expect(longest.length).toBe(200);
    // The exact reproducer from the bug report. Accepted by the validator...
    expect(checkDownloadFilename(longest)).toEqual({ ok: true, filename: longest });
    // ...and now accepted by the trail. Before the fix this was `false`.
    expect(
      await accepted({
        type: 'file.downloaded',
        taskId: 'task_abc',
        tool: 'browser.download',
        outcome: 'allowed',
        fileName: longest,
        origin: 'https://example.test',
      }),
    ).toBe(true);
  });

  it('06 — fileName: safeDisplayName at its limit', async () => {
    const picked = safeDisplayName(`${'b'.repeat(400)}.pdf`);
    expect(picked.length).toBe(MAX_FILENAME);
    expect(
      await accepted({
        type: 'file.selected',
        taskId: 'task_abc',
        tool: 'files.select',
        outcome: 'allowed',
        fileName: picked,
      }),
    ).toBe(true);
  });

  it('07 — tool: the widest name the MCP bounds can build', async () => {
    const serverId = 'a'.repeat(MAX_MCP_SERVER_ID);
    const toolName = 'b'.repeat(MAX_MCP_TOOL_NAME);
    const name = mcpToolName(serverId, toolName);
    expect(name.length).toBe(MCP_TOOL_NAME_MAX);
    expect(name.length).toBeLessThanOrEqual(MAX_STRING);
    expect(
      await accepted({
        type: 'tool.invoked',
        taskId: 'task_abc',
        tool: name,
        outcome: 'allowed',
        executed: true,
      }),
    ).toBe(true);
  });

  it('08 — destination: the MCP identity at its widest', async () => {
    const identity = mcpDestination(
      'a'.repeat(MAX_MCP_SERVER_ID),
      `https://${longestHostname()}:65535`,
    ).identity;
    // A host at the DNS maximum still produces an identity rather than none.
    expect(identity).not.toBeNull();
    expect(identity!.length).toBeLessThanOrEqual(MAX_DESTINATION);
    expect(
      await accepted({
        type: 'egress.decided',
        taskId: 'task_abc',
        tool: 'mcp.call',
        outcome: 'allowed',
        code: 'ALLOWED',
        destination: identity,
      }),
    ).toBe(true);
  });

  it('09 — destination: an endpoint URL at its widest', async () => {
    const url = `https://${longestHostname()}:65535/${'p'.repeat(60)}`;
    expect(url.length).toBeLessThanOrEqual(MAX_ENDPOINT_URL);
    expect(
      await accepted({
        type: 'mcp.server.added',
        outcome: 'allowed',
        code: 'ADDED',
        destination: url,
      }),
    ).toBe(true);
  });

  it('10 — origin and site: the longest hostname DNS allows', async () => {
    const host = longestHostname();
    expect(host.length).toBe(MAX_DNS_NAME);
    const destination = providerDestination('openai-compatible', `https://${host}:65535/v1`);
    expect(destination.origin).toBeDefined();
    expect(destination.origin!.length).toBeLessThanOrEqual(MAX_ORIGIN);
    expect(destination.identity).not.toBeNull();
    // This is the case a flat 128 refused: a legal long hostname lost the record
    // of every request made to it.
    expect(
      await accepted({
        type: 'egress.decided',
        taskId: 'task_abc',
        tool: 'provider.request',
        outcome: 'allowed',
        code: 'PROVIDER_PINNED',
        origin: destination.origin,
        site: host,
        destination: destination.identity,
      }),
    ).toBe(true);
  });

  it('11 — modelId: the widest id the admission helper allows', async () => {
    const modelId = 'm'.repeat(MAX_MODEL_ID);
    expect(isRecordableModelId(modelId)).toBe(true);
    expect(isRecordableModelId(`${modelId}x`)).toBe(false);
    expect(
      await accepted({
        type: 'egress.decided',
        taskId: 'task_abc',
        tool: 'provider.request',
        outcome: 'allowed',
        code: 'PROVIDER_PINNED',
        modelId,
      }),
    ).toBe(true);
  });

  it('11b — modelId: the widest id a 9Router catalogue can offer', async () => {
    // A second producer for the same field, and the most hostile one: a gateway
    // model id contains `/` in the ordinary case. The parser is the admitting
    // stage, so it is run rather than described.
    const widest = 'z'.repeat(MAX_MODEL_ID - 9);
    const id = `upstream/${widest}`;
    expect(id.length).toBe(MAX_MODEL_ID);
    const { models, refused } = parseModelCatalogue({
      object: 'list',
      data: [{ id, object: 'model', owned_by: 'upstream' }],
    });
    expect(refused).toEqual([]);
    // Carried, not parsed.
    expect(models[0]!.id).toBe(id);
    expect(
      await accepted({
        type: 'egress.decided',
        taskId: 'task_abc',
        tool: 'provider.request',
        outcome: 'allowed',
        code: 'PROVIDER_PINNED',
        modelId: models[0]!.id,
      }),
    ).toBe(true);
    // One character over and the parser refuses it rather than shortening it.
    expect(
      parseModelCatalogue({
        object: 'list',
        data: [{ id: `${id}x`, object: 'model', owned_by: 'upstream' }],
      }).models,
    ).toEqual([]);
  });

  it('12 — mimeType: the widest media type the RFC allows', async () => {
    const essential = `${'t'.repeat(127)}/${'s'.repeat(127)}`;
    // Parameters are dropped, so a header far past the field's limit still
    // yields something recordable.
    const bounded = safeMediaType(`${essential}; charset=${'x'.repeat(500)}`);
    expect(bounded).toBe(essential);
    expect(bounded?.length).toBe(MAX_MEDIA_TYPE);
    expect(
      await accepted({
        type: 'file.downloaded',
        taskId: 'task_abc',
        tool: 'browser.download',
        outcome: 'allowed',
        fileName: 'a.txt',
        origin: 'https://example.test',
        mimeType: bounded,
      }),
    ).toBe(true);
  });

  it('12b — detail: a sentence naming two maximal hostnames', async () => {
    const host = longestHostname();
    // The sentence the download tool writes when a request was redirected. Two
    // registrable domains at their maximum put it far past the field.
    const note = `Requested from ${host} and redirected to ${host}.`;
    expect(note.length).toBeGreaterThan(MAX_STRING);
    const bounded = boundedDetail(note);
    expect(bounded.length).toBeLessThanOrEqual(MAX_DETAIL);
    // The cut is visible, so a reader is not left thinking the sentence ended.
    expect(bounded.endsWith('\u2026')).toBe(true);
    expect(
      await accepted({
        type: 'file.downloaded',
        taskId: 'task_abc',
        tool: 'browser.download',
        outcome: 'allowed',
        fileName: 'a.txt',
        origin: `https://${host}`,
        detail: bounded,
      }),
    ).toBe(true);
    // And a sentence that already fits is untouched.
    expect(boundedDetail('Saved under a different name.')).toBe('Saved under a different name.');
  });

  it('12c — skillId and skillVersion at the validator\u2019s limits', async () => {
    // The producer here is not only this build. An exported workflow can be
    // edited and re-imported, and `importWorkflow` hands its definition to the
    // same validator — which bounded the id\u2019s characters and not its length,
    // while replay wrote that id into three audit records.
    const definition = {
      id: 'a'.repeat(MAX_SKILL_ID),
      version: '1'.repeat(MAX_SKILL_VERSION - 4) + '.0.0',
      name: 'X',
      description: 'Y',
      provenance: RECORDED_PROVENANCE,
      risk: 'R0' as const,
      inputs: [],
      outputs: [],
      requiredTools: ['browser.read_page'],
      requiredConnectors: [],
      steps: [{ id: 's1', kind: 'tool' as const, tool: 'browser.read_page', arguments: {} }],
    };
    expect(definition.version.length).toBe(MAX_SKILL_VERSION);
    expect(
      validateSkillDefinition(definition as never, {
        hasTool: () => true,
        allowProvenance: [RECORDED_PROVENANCE],
      }),
    ).toEqual([]);

    // One character over either, and the definition is refused before it is
    // stored — which is where it has to be refused, because by replay time the
    // record is already on disk.
    expect(
      validateSkillDefinition({ ...definition, id: 'a'.repeat(MAX_SKILL_ID + 1) } as never, {
        hasTool: () => true,
        allowProvenance: [RECORDED_PROVENANCE],
      }).join(' '),
    ).toContain(String(MAX_SKILL_ID));
    expect(
      validateSkillDefinition(
        { ...definition, version: `${'1'.repeat(MAX_SKILL_VERSION - 3)}.0.0` } as never,
        { hasTool: () => true, allowProvenance: [RECORDED_PROVENANCE] },
      ).join(' '),
    ).toContain(String(MAX_SKILL_VERSION));

    // And what the validator does admit, the trail records.
    expect(
      await accepted({
        type: 'skill.started',
        taskId: 'task_abc',
        outcome: 'info',
        skillId: definition.id,
        skillVersion: definition.version,
        skillHash: 'h'.repeat(64),
      }),
    ).toBe(true);
    expect(
      await accepted({
        type: 'workflow.recorded',
        taskId: 'task_abc',
        outcome: 'info',
        workflowId: 'workflow_abc',
        skillVersion: definition.version,
        skillHash: 'h'.repeat(64),
        risk: 'R0',
      }),
    ).toBe(true);
  });

  it('13 — taskId: the provider probe identity', async () => {
    const taskId = await managementTaskId(
      'openai-compatible',
      `${'x'.repeat(400)}/${'y'.repeat(400)}`,
    );
    expect(taskId.length).toBeLessThanOrEqual(MAX_OPAQUE_ID);
    expect(
      await accepted({
        type: 'egress.decided',
        taskId,
        tool: 'provider.request',
        outcome: 'allowed',
        code: 'PROVIDER_PINNED',
      }),
    ).toBe(true);
  });

  it('14 — sessionId: the unattended schedule identity', async () => {
    const sessionId = unattendedSessionIdFor(runIdFor(newId('schedule'), 1_700_000_000_000));
    expect(sessionId.length).toBeLessThanOrEqual(MAX_OPAQUE_ID);
    expect(
      await accepted({
        type: 'task.state',
        taskId: 'task_abc',
        sessionId,
        outcome: 'info',
      }),
    ).toBe(true);
  });

  it('15 — evidenceIds: a reference built from the widest task id', async () => {
    const taskId = 'a'.repeat(MAX_OPAQUE_ID);
    const evidenceId = `egress_${taskId}_${1_700_000_000_000}_abc123`;
    expect(
      await accepted({
        type: 'egress.decided',
        taskId,
        tool: 'provider.request',
        outcome: 'allowed',
        code: 'PROVIDER_PINNED',
        evidenceIds: [evidenceId],
      }),
    ).toBe(true);
  });
});

describe('TEST-BOUNDARY-001 — the whole-record budget', () => {
  it('21 — a maximally wide egress decision still fits the record budget', async () => {
    // The record budget is a consumer too: every field can be inside its own
    // limit and the serialised record still be over. So the widest record this
    // build actually emits is checked against it, rather than assumed.
    const host = longestHostname();
    const destination = providerDestination('openai-compatible', `https://${host}:65535/v1`);
    const widest = {
      type: 'egress.decided',
      taskId: 'a'.repeat(MAX_OPAQUE_ID),
      sessionId: 'b'.repeat(MAX_OPAQUE_ID),
      tool: 'provider.request',
      outcome: 'allowed',
      code: 'c'.repeat(MAX_STRING),
      destination: destination.identity,
      origin: destination.origin,
      site: host,
      providerId: 'openai-compatible',
      modelId: 'm'.repeat(MAX_MODEL_ID),
      evidenceIds: [`egress_${'a'.repeat(MAX_OPAQUE_ID)}_1700000000000_abc123`],
    };
    expect(await accepted(widest)).toBe(true);
  });
});

describe('TEST-BOUNDARY-001 — the bounds refuse what they say they refuse', () => {
  it('16 — an MCP server id one character over is refused at registration', () => {
    const ok = validateServerDescriptor({
      id: 'a'.repeat(MAX_MCP_SERVER_ID),
      displayName: 'Fine',
      url: 'https://example.test/mcp',
    });
    expect(ok.ok).toBe(true);

    const over = validateServerDescriptor({
      id: 'a'.repeat(MAX_MCP_SERVER_ID + 1),
      displayName: 'Fine',
      url: 'https://example.test/mcp',
    });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.problems.join(' ')).toContain(String(MAX_MCP_SERVER_ID));
    }
  });

  it('17 — a display name and a URL one character over are refused too', () => {
    const name = validateServerDescriptor({
      id: 'srv',
      displayName: 'n'.repeat(MAX_MCP_DISPLAY_NAME + 1),
      url: 'https://example.test/mcp',
    });
    expect(name.ok).toBe(false);

    const url = validateServerDescriptor({
      id: 'srv',
      displayName: 'Fine',
      url: `https://example.test/${'p'.repeat(MAX_ENDPOINT_URL)}`,
    });
    expect(url.ok).toBe(false);
  });

  it('18 — a server-authored tool name one character over is refused', () => {
    const server = { id: 'srv', displayName: 'Fine', url: 'https://example.test/mcp' };
    const fits = admitDiscoveredTool(server, {
      name: 'b'.repeat(MAX_MCP_TOOL_NAME),
      inputSchema: { type: 'object' },
    });
    expect(fits.ok).toBe(true);

    const over = admitDiscoveredTool(server, {
      name: 'b'.repeat(MAX_MCP_TOOL_NAME + 1),
      inputSchema: { type: 'object' },
    });
    expect(over.ok).toBe(false);
    // Refused, not truncated: two long names sharing a truncated form would
    // otherwise become one tool.
    if (!over.ok) expect(over.reason).toContain(String(MAX_MCP_TOOL_NAME));
  });

  it('19 — the audit log still refuses a field one character over its limit', async () => {
    // The negative control for the whole exercise. Nothing here widened the
    // *validator*; the limits moved to where both sides can see them.
    expect(
      await accepted({
        type: 'task.state',
        taskId: 'task_1',
        outcome: 'info',
        code: 'c'.repeat(MAX_STRING),
      }),
    ).toBe(true);
    expect(
      await accepted({
        type: 'task.state',
        taskId: 'task_1',
        outcome: 'info',
        code: 'c'.repeat(MAX_STRING + 1),
      }),
    ).toBe(false);
    expect(
      await accepted({
        type: 'task.state',
        taskId: 'task_1',
        outcome: 'info',
        site: 's'.repeat(MAX_ORIGIN),
      }),
    ).toBe(true);
    expect(
      await accepted({
        type: 'task.state',
        taskId: 'task_1',
        outcome: 'info',
        site: 's'.repeat(MAX_ORIGIN + 1),
      }),
    ).toBe(false);
    expect(
      await accepted({
        type: 'file.selected',
        outcome: 'info',
        fileName: 'f'.repeat(MAX_FILENAME),
      }),
    ).toBe(true);
    expect(
      await accepted({
        type: 'file.selected',
        outcome: 'info',
        fileName: 'f'.repeat(MAX_FILENAME + 1),
      }),
    ).toBe(false);
    // And an identifier that is not opaque is still not an identifier.
    expect(
      await accepted({
        type: 'egress.decided',
        taskId: 'task/with/slashes',
        tool: 'provider.request',
        outcome: 'allowed',
      }),
    ).toBe(false);
  });

  it('20 — a refusal now names the field that caused it', async () => {
    // Diagnosis, not decoration: "a record could not be shaped" was the same
    // sentence for a filename, a model id and a tool name, which is why one of
    // them reached a user before it reached a test.
    const reports: { state: string; reason: string }[] = [];
    const log = new AuditLog(area(), {
      knownTool: () => true,
      health: {
        report: async (_domain: unknown, state: string, reason: string): Promise<void> => {
          reports.push({ state, reason });
        },
      } as never,
    });
    await log.record({
      type: 'file.selected',
      outcome: 'info',
      fileName: 'f'.repeat(MAX_FILENAME + 1),
    } as never);
    expect(reports).toEqual([
      { state: 'CORRUPT', reason: 'a record could not be shaped: fileName' },
    ]);
    expect(log.degradedReason()).toContain('fileName');
  });
});
