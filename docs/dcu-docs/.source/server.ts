// @ts-nocheck
import * as __fd_glob_18 from "../content/docs/api-reference/updateGroup.mdx?collection=docs"
import * as __fd_glob_17 from "../content/docs/api-reference/updateAccount.mdx?collection=docs"
import * as __fd_glob_16 from "../content/docs/api-reference/terminateGroup.mdx?collection=docs"
import * as __fd_glob_15 from "../content/docs/api-reference/memberWithdraw.mdx?collection=docs"
import * as __fd_glob_14 from "../content/docs/api-reference/joinGroup.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/api-reference/exitGroup.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/api-reference/distributePayout.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/api-reference/deleteGroup.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/api-reference/deleteAccount.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/api-reference/createGroup.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/api-reference/createAccount.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/lifecycle.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/getting-started.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/error-reference.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/core-concepts.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/architecture.mdx?collection=docs"
import { default as __fd_glob_1 } from "../content/docs/api-reference/meta.json?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, "api-reference/meta.json": __fd_glob_1, }, {"architecture.mdx": __fd_glob_2, "core-concepts.mdx": __fd_glob_3, "error-reference.mdx": __fd_glob_4, "getting-started.mdx": __fd_glob_5, "index.mdx": __fd_glob_6, "lifecycle.mdx": __fd_glob_7, "api-reference/createAccount.mdx": __fd_glob_8, "api-reference/createGroup.mdx": __fd_glob_9, "api-reference/deleteAccount.mdx": __fd_glob_10, "api-reference/deleteGroup.mdx": __fd_glob_11, "api-reference/distributePayout.mdx": __fd_glob_12, "api-reference/exitGroup.mdx": __fd_glob_13, "api-reference/joinGroup.mdx": __fd_glob_14, "api-reference/memberWithdraw.mdx": __fd_glob_15, "api-reference/terminateGroup.mdx": __fd_glob_16, "api-reference/updateAccount.mdx": __fd_glob_17, "api-reference/updateGroup.mdx": __fd_glob_18, });