export function summarizeTurn(events, status) {
  // 未结束时先把公开文本当作阶段说明，成功后只将最后一个正常结束步骤移到进展下方。
  const end = status === 'succeeded' ? events.findLastIndex(event =>
    event.type === 'step' && event.payload.status === 'finished' && event.payload.reason === 'stop') : -1;
  const start = end < 0 ? -1 : events.findLastIndex((event, index) =>
    index < end && event.type === 'step' && event.payload.status === 'started');
  const progress = [];
  const final = [];
  for (const [index, event] of events.entries()) {
    if (event.type === 'tool') progress.push(event);
    if (event.type !== 'text') continue;
    if (end >= 0 && index > start && index < end) final.push(event.payload.text);
    else progress.push(event);
  }
  return { progress, finalText: final.join('\n\n') };
}
