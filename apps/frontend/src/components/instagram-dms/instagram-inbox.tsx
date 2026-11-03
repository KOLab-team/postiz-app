'use client';

import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

type Participant = { id: string; name?: string; username?: string };
type Conversation = {
  id: string;
  updated_time?: string;
  participants?: { data?: Participant[] };
};
type Message = {
  id: string;
  created_time?: string;
  from?: Participant;
  message?: string;
  attachments?: { data?: { type?: string }[] };
};
type Page<T> = { data: T[]; paging: { after: string | null } };
type MessagePage = Page<Message> & { accountParticipantId?: string };
type Channel = {
  id: string;
  name: string;
  identifier: string;
  internalId: string;
  disabled: boolean;
  inBetweenSteps: boolean;
};

function time(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Instagram could not load this inbox.';
}

export function InstagramInbox() {
  const fetch = useFetch();
  const { data: integrations, isLoading: channelsLoading } = useIntegrationList();
  const channels = ((integrations ?? []) as Channel[]).filter((item) =>
    ['instagram', 'instagram-standalone'].includes(item.identifier) &&
    !item.disabled && !item.inBetweenSteps
  );
  const [channelId, setChannelId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationAfter, setConversationAfter] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [accountParticipantId, setAccountParticipantId] = useState('');
  const [messageAfter, setMessageAfter] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const conversationRequest = useRef(0);
  const messageRequest = useRef(0);
  const sendingRequest = useRef(false);

  const selectedChannel = channels.find((item) => item.id === channelId);
  const selectedConversation = conversations.find((item) => item.id === conversationId);

  useEffect(() => {
    if (!channels.length) return;
    if (!channels.some((item) => item.id === channelId)) {
      setChannelId(channels.find((item) => /10lab threads marketing/i.test(item.name))?.id ?? channels[0].id);
    }
  }, [channels, channelId]);

  const request = useCallback(async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = Array.isArray(body.message) ? body.message.join(' ') : body.message;
      throw new Error(typeof message === 'string' ? message : 'Instagram could not complete the request.');
    }
    return body as T;
  }, [fetch]);

  const loadConversations = useCallback(async (id: string, after?: string) => {
    const current = ++conversationRequest.current;
    setLoadingConversations(true);
    setError('');
    try {
      const page = await request<Page<Conversation>>(
        `/instagram-dms/${encodeURIComponent(id)}/conversations?limit=20${after ? `&after=${encodeURIComponent(after)}` : ''}`
      );
      if (current !== conversationRequest.current) return;
      setConversations((old) => after ? [...old, ...page.data.filter((item) => !old.some((prev) => prev.id === item.id))] : page.data);
      setConversationAfter(page.paging.after);
    } catch (err) {
      if (current === conversationRequest.current) setError(errorText(err));
    } finally {
      if (current === conversationRequest.current) setLoadingConversations(false);
    }
  }, [request]);

  const loadMessages = useCallback(async (id: string, conversation: string, after?: string) => {
    const current = ++messageRequest.current;
    setLoadingMessages(true);
    setError('');
    try {
      const page = await request<MessagePage>(
        `/instagram-dms/${encodeURIComponent(id)}/conversations/${encodeURIComponent(conversation)}/messages?limit=20${after ? `&after=${encodeURIComponent(after)}` : ''}`
      );
      if (current !== messageRequest.current) return;
      setMessages((old) => after ? [...old, ...page.data.filter((item) => !old.some((prev) => prev.id === item.id))] : page.data);
      setAccountParticipantId(page.accountParticipantId ?? '');
      setMessageAfter(page.paging.after);
    } catch (err) {
      if (current === messageRequest.current) setError(errorText(err));
    } finally {
      if (current === messageRequest.current) setLoadingMessages(false);
    }
  }, [request]);

  useEffect(() => {
    ++conversationRequest.current;
    ++messageRequest.current;
    setConversationId('');
    setConversations([]);
    setMessages([]);
    setAccountParticipantId('');
    setDraft('');
    setNotice('');
    setError('');
    if (channelId) void loadConversations(channelId);
  }, [channelId, loadConversations]);

  useEffect(() => {
    ++messageRequest.current;
    setMessages([]);
    setMessageAfter(null);
    setDraft('');
    setNotice('');
    setError('');
    if (channelId && conversationId) void loadMessages(channelId, conversationId);
  }, [channelId, conversationId, loadMessages]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!channelId || !conversationId || !text || sendingRequest.current) return;
    sendingRequest.current = true;
    setSending(true);
    setError('');
    setNotice('');
    try {
      await request<{ messageId: string }>(
        `/instagram-dms/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(conversationId)}/replies`,
        { method: 'POST', body: JSON.stringify({ text }) }
      );
      setDraft('');
      setNotice('Reply sent.');
      await Promise.all([loadMessages(channelId, conversationId), loadConversations(channelId)]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      sendingRequest.current = false;
      setSending(false);
    }
  }

  const otherParticipant = (conversation: Conversation) =>
    conversation.participants?.data?.find((item) =>
      item.id !== selectedChannel?.internalId &&
      (conversation.id !== conversationId || item.id !== accountParticipantId)
    ) ??
    conversation.participants?.data?.[0];

  return (
    <div className="flex flex-1 min-w-0 bg-newBgColorInner text-newTextColor max-lg:flex-col">
      <section className="w-[340px] max-lg:w-full shrink-0 border-e border-newBgLineColor flex flex-col min-h-0">
        <div className="p-5 border-b border-newBgLineColor flex flex-col gap-3">
          <label htmlFor="instagram-channel" className="text-sm font-semibold">Instagram account</label>
          <select id="instagram-channel" className="w-full rounded-lg bg-newBgLineColor p-3" value={channelId}
            onChange={(event) => setChannelId(event.target.value)} disabled={sending}>
            {!channelId && <option value="">Choose an account</option>}
            {channels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button type="button" className="self-start text-sm underline disabled:opacity-50"
            onClick={() => channelId && loadConversations(channelId)} disabled={!channelId || loadingConversations}>Refresh conversations</button>
        </div>
        <div className="overflow-y-auto flex-1">
          {channelsLoading && <p className="p-5 text-sm text-textItemBlur">Loading accounts…</p>}
          {!channelsLoading && !channels.length && <p className="p-5 text-sm text-textItemBlur">Connect an Instagram account to view its messages.</p>}
          {!loadingConversations && channelId && !conversations.length && !error && <p className="p-5 text-sm text-textItemBlur">No conversations yet.</p>}
          {conversations.map((item) => {
            const person = otherParticipant(item);
            return <button key={item.id} type="button" disabled={sending} onClick={() => setConversationId(item.id)}
              className={`w-full text-left p-4 border-b border-newBgLineColor hover:bg-newBgLineColor ${item.id === conversationId ? 'bg-newBgLineColor' : ''}`}>
              <span className="block font-semibold truncate">{person?.username || person?.name || 'Instagram user'}</span>
              <span className="block text-xs text-textItemBlur mt-1">{time(item.updated_time)}</span>
            </button>;
          })}
          {conversationAfter && <button type="button" className="w-full p-4 text-sm underline disabled:opacity-50"
            disabled={loadingConversations} onClick={() => channelId && loadConversations(channelId, conversationAfter)}>Load more conversations</button>}
          {loadingConversations && <p className="p-4 text-sm text-textItemBlur">Loading conversations…</p>}
        </div>
      </section>
      <section className="flex-1 min-w-0 flex flex-col min-h-[500px]">
        <div className="p-5 border-b border-newBgLineColor font-semibold">
          {selectedConversation ? otherParticipant(selectedConversation)?.username || otherParticipant(selectedConversation)?.name || 'Instagram conversation' : 'Select a conversation'}
        </div>
        {error && <div role="alert" className="m-4 rounded-lg bg-red-500/10 text-red-400 p-3 text-sm">{error}</div>}
        {notice && <div role="status" className="m-4 rounded-lg bg-green-500/10 text-green-400 p-3 text-sm">{notice}</div>}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-3">
          {conversationId && <div className="flex justify-center gap-4 mb-2">
            {messageAfter && <button type="button" className="text-sm underline disabled:opacity-50" disabled={loadingMessages}
              onClick={() => loadMessages(channelId, conversationId, messageAfter)}>Load older messages</button>}
            <button type="button" className="text-sm underline disabled:opacity-50" disabled={loadingMessages}
              onClick={() => loadMessages(channelId, conversationId)}>Refresh messages</button>
          </div>}
          {loadingMessages && <p className="text-sm text-textItemBlur">Loading messages…</p>}
          {conversationId && !loadingMessages && !messages.length && !error && <p className="text-sm text-textItemBlur">No messages in this conversation.</p>}
          {[...messages].reverse().map((item) => {
            const own = item.from?.id === accountParticipantId;
            return <div key={item.id} className={`max-w-[80%] rounded-xl px-4 py-3 text-sm whitespace-pre-wrap break-words ${own ? 'self-end bg-purple-600 text-white' : 'self-start bg-newBgLineColor'}`}>
              {item.message || (item.attachments?.data?.length ? 'Attachment' : 'Message')}
              <div className={`text-xs mt-2 ${own ? 'text-white/70' : 'text-textItemBlur'}`}>{time(item.created_time)}</div>
            </div>;
          })}
        </div>
        {conversationId && <form onSubmit={send} className="p-4 border-t border-newBgLineColor flex gap-3 items-end">
          <label htmlFor="instagram-reply" className="sr-only">Reply to Instagram message</label>
          <textarea id="instagram-reply" value={draft} onChange={(event) => setDraft(event.target.value)}
            maxLength={1000} rows={2} placeholder="Write a reply…" disabled={sending}
            className="flex-1 min-w-0 rounded-lg bg-newBgLineColor p-3 resize-none" />
          <button type="submit" disabled={!draft.trim() || sending} className="rounded-lg bg-purple-600 text-white px-5 py-3 font-semibold disabled:opacity-50">
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>}
      </section>
    </div>
  );
}
