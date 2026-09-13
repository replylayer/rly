"""Read-only hosted MCP example; install requirements-workflows.txt first."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools


async def load_with_instructions(session):
    """Explicitly preserve initialization instructions alongside converted tools."""
    initialized = await session.initialize()
    if not initialized.instructions:
        raise RuntimeError("MCP server supplied no workflow instructions")
    tools = await load_mcp_tools(session)
    # This connectivity example grants only a read-only quota check.
    selected = [tool for tool in tools if tool.name == "check_send_quota"]
    if len(selected) != 1:
        raise RuntimeError("MCP server did not expose check_send_quota")
    return initialized.instructions, selected


@asynccontextmanager
async def hosted_tools():
    client = MultiServerMCPClient({
        "replylayer": {
            "transport": "streamable_http",
            "url": os.environ.get("REPLYLAYER_MCP_URL", "https://api.replylayer.ai/mcp"),
            "headers": {"Authorization": f"Bearer {os.environ['REPLYLAYER_API_KEY']}"},
        }
    })
    async with client.session("replylayer", auto_initialize=False) as session:
        yield await load_with_instructions(session)


async def main():
    async with hosted_tools() as (instructions, tools):
        # For an agent, pass instructions into its system context and tools into
        # its tool list; invoke the agent before leaving this session context.
        print(instructions)
        print(await tools[0].ainvoke({}))


if __name__ == "__main__":
    asyncio.run(main())
