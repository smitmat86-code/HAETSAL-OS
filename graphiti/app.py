from __future__ import annotations

import asyncio
import os
import re
from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import FastAPI
from pydantic import BaseModel

from graphiti_core.driver.kuzu_driver import KuzuDriver
from graphiti_core.edges import EntityEdge, EpisodicEdge
from graphiti_core.nodes import EntityNode, EpisodeType, EpisodicNode

PERSON_STOPWORDS = {
    'Assistant',
    'I',
    'It',
    'Monday',
    'The',
    'They',
    'Thursday',
    'Today',
    'Tomorrow',
    'Tuesday',
    'User',
    'Wednesday',
    'We',
    'Yesterday',
}
ORG_HINTS = {
    'agency',
    'company',
    'corp',
    'corporation',
    'foundation',
    'group',
    'inc',
    'labs',
    'llc',
    'partners',
    'school',
    'studio',
    'systems',
    'team',
    'university',
}
PROJECT_HINTS = {
    'api',
    'checklist',
    'initiative',
    'launch',
    'migration',
    'milestone',
    'plan',
    'platform',
    'program',
    'project',
    'roadmap',
    'rollout',
    'service',
    'system',
}
DATE_FRAGMENT = r'(?:\d{4}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4})'
ENTITY_FRAGMENT = r'[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,5}'
RELATION_PATTERNS = [
    (
        'leads',
        re.compile(rf'(?P<left>{ENTITY_FRAGMENT})\s+leads\s+(?P<right>{ENTITY_FRAGMENT})(?:\s+on\s+(?P<date>{DATE_FRAGMENT}))?'),
    ),
    (
        'partnered_with',
        re.compile(rf'(?P<left>{ENTITY_FRAGMENT})\s+partnered\s+with\s+(?P<right>{ENTITY_FRAGMENT})(?:\s+on\s+(?P<date>{DATE_FRAGMENT}))?'),
    ),
    (
        'met_with',
        re.compile(rf'(?P<left>{ENTITY_FRAGMENT})\s+met\s+(?:with\s+)?(?P<right>{ENTITY_FRAGMENT})(?:\s+on\s+(?P<date>{DATE_FRAGMENT}))?'),
    ),
    (
        'depends_on',
        re.compile(rf'(?P<left>{ENTITY_FRAGMENT})\s+depends\s+on\s+(?P<right>{ENTITY_FRAGMENT})(?:\s+on\s+(?P<date>{DATE_FRAGMENT}))?'),
    ),
]


def to_datetime(value: int | None) -> datetime:
    if value is None:
        return datetime.now(UTC)
    return datetime.fromtimestamp(value / 1000, tz=UTC)


def graph_ref(kind: str, canonical_key: str) -> str:
    return f'graphiti://{kind}/{quote(canonical_key, safe="")}'


def slugify(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = re.sub(r'[^a-z0-9]+', '-', value.strip().lower()).strip('-')
    return normalized or None


def normalize_entity_label(value: str | None) -> str | None:
    if not value:
        return None
    normalized = re.sub(r'^[("`\']+|[)"`\'.;,!?]+$', '', value.strip())
    normalized = re.sub(r'\s+', ' ', normalized)
    return normalized or None


def looks_like_person_name(value: str) -> bool:
    label = normalize_entity_label(value)
    if not label or label in PERSON_STOPWORDS:
        return False
    parts = label.split(' ')
    if len(parts) > 3:
        return False
    if any(part.lower() in ORG_HINTS or part.lower() in PROJECT_HINTS for part in parts):
        return False
    return all(re.match(r'^[A-Z][A-Za-z0-9.-]*$', part) for part in parts)


def infer_work_entity_kind(label: str, fallback: str) -> str:
    tokens = {part for part in re.split(r'[^a-z0-9]+', label.lower()) if part}
    if tokens & ORG_HINTS:
        return 'organization'
    if tokens & PROJECT_HINTS:
        return 'project'
    return fallback


def build_entity_key(kind: str, label: str) -> str:
    slug = slugify(label)
    path = {
        'person': 'people',
        'organization': 'organizations',
        'project': 'projects',
    }.get(kind, f'{kind}s')
    return f'canonical://{path}/{slug or quote(label, safe="")}'


def build_edge_key(
    from_canonical_key: str,
    relation: str,
    to_canonical_key: str,
    valid_at: int | None,
) -> str:
    suffix = f'@{valid_at}' if valid_at else ''
    return f'canonical://edges/{quote(from_canonical_key, safe="")}:{relation}:{quote(to_canonical_key, safe="")}{suffix}'


def parse_explicit_date(value: str | None) -> int | None:
    if not value:
        return None
    raw = value.strip()
    if re.match(r'^\d{4}-\d{2}-\d{2}$', raw):
        return int(datetime.fromisoformat(f'{raw}T00:00:00+00:00').timestamp() * 1000)
    try:
        return int(datetime.strptime(raw, '%B %d, %Y').replace(tzinfo=UTC).timestamp() * 1000)
    except ValueError:
        try:
            return int(datetime.strptime(raw, '%b %d, %Y').replace(tzinfo=UTC).timestamp() * 1000)
        except ValueError:
            return None


def extract_body_candidates(body: str, captured_at: int | None) -> tuple[list[dict], list[dict]]:
    if not body.strip():
        return [], []
    cleaned = '. '.join(
        filter(
            None,
            (
                re.sub(r'^\s*(User|Assistant):\s*', '', line.strip(), flags=re.IGNORECASE)
                for line in re.split(r'\r?\n+', body)
            ),
        ),
    )
    entities: dict[str, dict] = {}
    edges: dict[str, dict] = {}
    for relation, pattern in RELATION_PATTERNS:
        for match in pattern.finditer(cleaned):
            left_label = normalize_entity_label(match.group('left'))
            right_label = normalize_entity_label(match.group('right'))
            if not left_label or not right_label or left_label == right_label:
                continue
            if relation == 'met_with' and not (looks_like_person_name(left_label) and looks_like_person_name(right_label)):
                continue
            left_kind = 'person' if relation in {'leads', 'met_with'} else infer_work_entity_kind(left_label, 'organization' if relation == 'partnered_with' else 'project')
            right_kind = (
                'person'
                if relation == 'met_with'
                else infer_work_entity_kind(right_label, 'organization' if relation == 'partnered_with' else 'project')
            )
            valid_at = parse_explicit_date(match.groupdict().get('date')) or captured_at
            left_key = build_entity_key(left_kind, left_label)
            right_key = build_entity_key(right_kind, right_label)
            entities[left_key] = {
                'canonicalKey': left_key,
                'kind': left_kind,
                'label': left_label,
                'identityStrategy': 'content_extracted',
                'source': 'content_candidate',
            }
            entities[right_key] = {
                'canonicalKey': right_key,
                'kind': right_kind,
                'label': right_label,
                'identityStrategy': 'content_extracted',
                'source': 'content_candidate',
            }
            edge_key = build_edge_key(left_key, relation, right_key, valid_at)
            edges[edge_key] = {
                'canonicalKey': edge_key,
                'fromCanonicalKey': left_key,
                'toCanonicalKey': right_key,
                'relation': relation,
                'temporalMode': 'append_valid_time',
                'validAt': valid_at,
            }
    return list(entities.values()), list(edges.values())


def merge_graph_facts(plan: dict, body: str) -> tuple[list[dict], list[dict]]:
    entities = {entity['canonicalKey']: entity for entity in plan.get('entities', [])}
    edges = {edge['canonicalKey']: edge for edge in plan.get('edges', [])}
    extracted_entities, extracted_edges = extract_body_candidates(body, plan.get('episode', {}).get('validAt'))
    for entity in extracted_entities:
      entities.setdefault(entity['canonicalKey'], entity)
    for edge in extracted_edges:
      edges.setdefault(edge['canonicalKey'], edge)
    return list(entities.values()), list(edges.values())


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
            entities, edges = merge_graph_facts(request.plan, request.content.get('body', ''))
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
