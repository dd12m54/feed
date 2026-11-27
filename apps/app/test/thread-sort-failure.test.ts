// @vitest-environment happy-dom
// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { openThread } from "../src/web/store-world.ts";
import { makeViewerSession, stubFetchByUrl } from "./app-test-helpers.tsx";
import { decodedPost, postRaw, seedFeedStore } from "./moderation-fixtures.ts";

const viewer = makeViewerSession();

const threadPost = decodedPost(postRaw({ id: "post-1" }));
const popularReply = decodedPost(postRaw({ id: "reply-popular", replyToPostId: "post-1", likeCount: 9 }));
const newestReply = decodedPost(postRaw({ id: "reply-newest", replyToPostId: "post-1", likeCount: 0 }));

let failThread = false;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  failThread = false;
  stubFetchByUrl((url) => {
    if (url.pathname === "/api/posts/post-1") {
      if (failThread) return Promise.resolve(jsonResponse({ message: "Thread failed" }, 500));
      return Promise.resolve(jsonResponse({
        post: postRaw({ id: "post-1" }),
        parentPost: null,
        ancestors: [],
        replies: [
          postRaw({ id: "reply-newest", replyToPostId: "post-1", likeCount: 0 }),
          postRaw({ id: "reply-popular", replyToPostId: "post-1", likeCount: 9 }),
        ],
      }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  seedFeedStore({
    viewer,
    route: "PostDetail",
    feedPosts: [threadPost],
    activeThread: { post: threadPost, parentPost: null, ancestors: [], replies: [popularReply, newestReply] },
    activePostId: "post-1",
    threadSort: "popular",
    threadLoading: false,
  });
});

function expectPopularThreadKept(): void {
  const s = getStoreSnapshot();
  expect(s.threadSort).toBe("popular");
  expect(s.activeThread?.replies.map((r) => r.card.id)).toEqual(["reply-popular", "reply-newest"]);
  expect(s.errorMessage).toBe("Thread failed");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps the previous reply sort when switching sorts fails (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  failThread = true;
  await openThread("post-1", "newest");
  expectPopularThreadKept();
});

it("applies the new reply sort when switching sorts succeeds (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  await openThread("post-1", "newest");
  const s = getStoreSnapshot();
  expect(s.threadSort).toBe("newest");
  expect(s.activeThread?.replies.map((r) => r.card.id)).toEqual(["reply-newest", "reply-popular"]);
});

it("keeps the current reply sort when a same-sort refresh fails (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  failThread = true;
  await openThread("post-1", "popular");
  expectPopularThreadKept();
});
