// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"architecture.mdx": () => import("../content/docs/architecture.mdx?collection=docs"), "core-concepts.mdx": () => import("../content/docs/core-concepts.mdx?collection=docs"), "error-reference.mdx": () => import("../content/docs/error-reference.mdx?collection=docs"), "getting-started.mdx": () => import("../content/docs/getting-started.mdx?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "lifecycle.mdx": () => import("../content/docs/lifecycle.mdx?collection=docs"), "api-reference/createAccount.mdx": () => import("../content/docs/api-reference/createAccount.mdx?collection=docs"), "api-reference/createGroup.mdx": () => import("../content/docs/api-reference/createGroup.mdx?collection=docs"), "api-reference/deleteAccount.mdx": () => import("../content/docs/api-reference/deleteAccount.mdx?collection=docs"), "api-reference/deleteGroup.mdx": () => import("../content/docs/api-reference/deleteGroup.mdx?collection=docs"), "api-reference/distributePayout.mdx": () => import("../content/docs/api-reference/distributePayout.mdx?collection=docs"), "api-reference/exitGroup.mdx": () => import("../content/docs/api-reference/exitGroup.mdx?collection=docs"), "api-reference/joinGroup.mdx": () => import("../content/docs/api-reference/joinGroup.mdx?collection=docs"), "api-reference/memberWithdraw.mdx": () => import("../content/docs/api-reference/memberWithdraw.mdx?collection=docs"), "api-reference/terminateGroup.mdx": () => import("../content/docs/api-reference/terminateGroup.mdx?collection=docs"), "api-reference/updateAccount.mdx": () => import("../content/docs/api-reference/updateAccount.mdx?collection=docs"), "api-reference/updateGroup.mdx": () => import("../content/docs/api-reference/updateGroup.mdx?collection=docs"), }),
};
export default browserCollections;