from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import FastAPI
from pydantic import BaseModel

from graphiti_core.driver.kuzu_driver import KuzuDriver
from graphiti_core.edges import EntityEdge, EpisodicEdge
from graphiti_core.nodes import EntityNode, EpisodeType, EpisodicNode


def to_datetime(value: int | None) -> datetime:
    if value is None:
        return datetime.now(UTC)
    return datetime.fromtimestamp(value / 1000, tz=UTC)


def graph_ref(kind: str, canonical_key: str) -> str:
    return f'graphiti://{kind}/{quote(canonical_key, safe="")}'


class ProjectionInput(BaseModel):
    tenantId: str
    projectionJobId: str
    captureId: str
    operationId: str
    documentId: str
    posture: str
    plan: dict
    content: dict


class GraphitiRuntime:
    def __init__(self) -> None:
        self.driver = KuzuDriver(db=os.environ.get('GRAPHITI_KUZU_PATH', '/tmp/graphiti.kuzu'))
        self.lock = asyncio.Lock()

    async def submit(self, request: ProjectionInput) -> dict:
        async with self.lock:
            episode_plan = request.plan['episode']
            entities = request.plan.get('entities', [])
            edges = request.plan.get('edges', [])
            valid_at = to_datetime(episode_plan.get('validAt'))
            episode = EpisodicNode(
                uuid=episode_plan['canonicalKey'],
                name=episode_plan.get('title') or request.captureId,
                group_id=request.tenantId,
                labels=['CanonicalEpisode'],
                source=EpisodeType.message if episode_plan.get('kind') == 'conversation' else EpisodeType.text,
                source_description=request.plan['input']['sourceSystem'],
                content=request.content.get('body', ''),
                valid_at=valid_at,
                entity_edges=[edge['canonicalKey'] for edge in edges],
                created_at=valid_at,
            )
            await episode.save(self.driver)

            for entity in entities:
                await EntityNode(
                    uuid=entity['canonicalKey'],
                    name=entity['label'],
                    group_id=request.tenantId,
                    labels=['CanonicalAnchor', entity['kind']],
                    created_at=valid_at,
                    summary='',
                    attributes={
                        'canonical_key': entity['canonicalKey'],
                        'kind': entity['kind'],
                        'source': entity['source'],
                    },
                ).save(self.driver)

            for edge in edges:
                if edge['fromCanonicalKey'] == episode.uuid:
                    await EpisodicEdge(
                        uuid=edge['canonicalKey'],
                        group_id=request.tenantId,
                        source_node_uuid=episode.uuid,
                        target_node_uuid=edge['toCanonicalKey'],
                        created_at=to_datetime(edge.get('validAt')),
                    ).save(self.driver)
                    continue

                await EntityEdge(
                    uuid=edge['canonicalKey'],
                    group_id=request.tenantId,
                    source_node_uuid=edge['fromCanonicalKey'],
                    target_node_uuid=edge['toCanonicalKey'],
                    created_at=to_datetime(edge.get('validAt')),
                    name=edge['relation'],
                    fact=f"{edge['fromCanonicalKey']} {edge['relation']} {edge['toCanonicalKey']}",
                    episodes=[episode.uuid],
                    valid_at=to_datetime(edge.get('validAt')),
                    attributes={'canonical_key': edge['canonicalKey']},
                ).save(self.driver)

            return {
                'status': 'completed',
                'targetRef': graph_ref('episodes', episode.uuid),
                'episodeRefs': [graph_ref('episodes', episode.uuid)],
                'entityRefs': [graph_ref('entities', entity['canonicalKey']) for entity in entities],
                'edgeRefs': [graph_ref('edges', edge['canonicalKey']) for edge in edges],
                'mappings': [
                    {
                        'canonicalKey': episode.uuid,
                        'graphRef': graph_ref('episodes', episode.uuid),
                        'graphKind': 'episode',
                    },
                    *[
                        {
                            'canonicalKey': entity['canonicalKey'],
                            'graphRef': graph_ref('entities', entity['canonicalKey']),
                            'graphKind': 'entity',
                        }
                        for entity in entities
                    ],
                    *[
                        {
                            'canonicalKey': edge['canonicalKey'],
                            'graphRef': graph_ref('edges', edge['canonicalKey']),
                            'graphKind': 'edge',
                        }
                        for edge in edges
                    ],
                ],
            }


runtime = GraphitiRuntime()
app = FastAPI()


@app.get('/health')
async def health() -> dict:
    return {'status': 'ok', 'ready': True, 'backend': 'graphiti-core+kuzu'}


@app.get('/ready')
async def ready() -> dict:
    return {'status': 'ready', 'ready': True}


@app.post('/v1/canonical/projections')
async def canonical_projection(request: ProjectionInput) -> dict:
    return await runtime.submit(request)
