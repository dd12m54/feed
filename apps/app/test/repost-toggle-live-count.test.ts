// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { repostPost } from "../src/web/store-world.ts";
import { eventSources, installStubEventSource, makeViewerSession, stubFetchByUrl } from "./app-test-helpers.tsx";
import { decodedPost, postRaw, seedFeedStore } from "./moderation-fixtures.ts";

const viewer = makeViewerSession();

const basePost = decodedPost(postRaw({ id: "post-1", repostCount: 3, repostedByViewer: false }));

let releaseRepost: ((response: Response) => void) | null = null;

function errorResponse(message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  releaseRepost = null;
  eventSources.length = 0;
  installStubEventSource(eventSources);
  stubFetchByUrl((url) => {
    if (url.pathname === "/api/posts/post-1/repost") {
      return new Promise<Response>((resolve) => { releaseRepost = resolve; });
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
  });
  seedFeedStore({ viewer, feedPosts: [basePost] });
});

afterEach(() => {
  eventSources.length = 0;
  vi.unstubAllGlobals();
});

it("keeps a live repost count that landed while the repost request was in flight when the repost then fails (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  reconnectRealtime();
  const toggle = repostPost("post-1");
  eventSources.at(-1)?.dispatchEvent(
    new MessageEvent("post.engagement", {
      data: JSON.stringify({ type: "post.engagement", postId: "post-1", kind: "repost", likeCount: 0, repostCount: 7 }),
    }),
  );
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(7);
  releaseRepost?.(errorResponse("Repost failed"));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(7);
  expect(getStoreSnapshot().errorMessage).toBe("Repost failed");
});

it("restores the pre-click repost count when the repost fails with no live engagement in between (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const toggle = repostPost("post-1");
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(4);
  releaseRepost?.(errorResponse("Repost failed"));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(3);
  expect(getStoreSnapshot().errorMessage).toBe("Repost failed");
});
