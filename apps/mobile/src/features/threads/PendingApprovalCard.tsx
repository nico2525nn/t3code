import type { ApprovalRequestId, ProviderApprovalDecision } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly approval: PendingApproval;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  return (
    <View className="gap-2.5 rounded-[20px] border border-adaptive-neutral-200-white-a6 bg-adaptive-neutral-100-900 p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-adaptive-sky-700-300">
        Approval needed
      </Text>
      <Text className="font-t3-bold text-lg text-adaptive-neutral-950-50">
        {props.approval.requestKind}
      </Text>
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-adaptive-neutral-600-400">
          {props.approval.detail}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        <Pressable
          className="items-center justify-center rounded-[14px] bg-blue-500 px-3.5 py-3"
          disabled={props.respondingApprovalId === props.approval.requestId}
          onPress={() => void props.onRespond(props.approval.requestId, "accept")}
        >
          <Text className="font-t3-extrabold text-sm text-white">Allow once</Text>
        </Pressable>
        <Pressable
          className="items-center justify-center rounded-[14px] bg-adaptive-neutral-200-800 px-3.5 py-3"
          disabled={props.respondingApprovalId === props.approval.requestId}
          onPress={() => void props.onRespond(props.approval.requestId, "acceptForSession")}
        >
          <Text className="font-t3-bold text-sm text-adaptive-neutral-950-50">Allow session</Text>
        </Pressable>
        <Pressable
          className="items-center justify-center rounded-[14px] bg-adaptive-rose-100-500-a18 px-3.5 py-3"
          disabled={props.respondingApprovalId === props.approval.requestId}
          onPress={() => void props.onRespond(props.approval.requestId, "decline")}
        >
          <Text className="font-t3-bold text-sm text-adaptive-rose-700-300">Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}
