import { revalidatePath } from "next/cache";

export function revalidateOwnerFlightViews() {
  revalidatePath("/map");
  revalidatePath("/flights");
}
