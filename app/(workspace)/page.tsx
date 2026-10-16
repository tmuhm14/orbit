import { orbitPage } from "./orbit-page";

export default async function Home({ searchParams }: {
  searchParams: Promise<{ view?: string; focus?: string }>;
}) {
  const { view, focus } = await searchParams;
  return orbitPage(view, focus === "search");
}
