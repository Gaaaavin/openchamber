import { formatMessage, useI18nStore } from "@/lib/i18n/store"
import { toast } from "sonner"

type ControlMutationToastKind = "abort" | "revert"

export function showControlMutationWarning(kind: ControlMutationToastKind): void {
  const { dictionary } = useI18nStore.getState()
  toast.warning(formatMessage(dictionary, `fork.${kind}.timeout.title`), {
    description: formatMessage(dictionary, `fork.${kind}.timeout.description`),
  })
}
