"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface ChatOperation {
  generation: number;
  controller: AbortController;
}

/** Owns one conversation's requests and one synchronous action reservation. */
export function useChatSession() {
  const generation = useRef(0);
  const action = useRef<ChatOperation | null>(null);
  const requests = useRef(new Set<ChatOperation>());
  const [completedAction, setCompletedAction] = useState<ChatOperation | null>(null);
  const beginRequest = useCallback((): ChatOperation => {
    const operation = { generation: generation.current, controller: new AbortController() };
    requests.current.add(operation);
    return operation;
  }, []);
  const beginAction = useCallback((): ChatOperation | null => {
    if (action.current) return null;
    const operation = beginRequest();
    action.current = operation;
    return operation;
  }, [beginRequest]);
  const isCurrent = useCallback((operation: ChatOperation) =>
    operation.generation === generation.current && requests.current.has(operation), []);
  const finish = useCallback((operation: ChatOperation): boolean => {
    const current = isCurrent(operation);
    requests.current.delete(operation);
    // Keep the reservation until the resulting interaction state is committed.
    if (action.current === operation) setCompletedAction(operation);
    return current;
  }, [isCurrent]);
  useLayoutEffect(() => {
    if (action.current === completedAction) action.current = null;
  }, [completedAction]);
  const invalidate = useCallback(() => {
    generation.current++;
    action.current = null;
    for (const operation of requests.current) operation.controller.abort();
    requests.current.clear();
  }, []);
  useEffect(() => invalidate, [invalidate]);
  return { beginRequest, beginAction, isCurrent, finish, invalidate };
}
