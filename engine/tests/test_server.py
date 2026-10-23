import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server import split_script, graph_to_api, patch_workflow


def test_split_script_preserves_all_words_in_order():
    story = "كان الرجل يمشي في الليل، ثم توقف. وبعدها عاد إلى منزله! لم ينسَ ما حدث؟"
    scenes = split_script(story, 1)
    assert len(scenes) >= 1
    assert " ".join(" ".join(scenes).split()) == " ".join(story.split())


def test_split_script_caps_scene_length_and_omits_no_text():
    story = " ".join([f"كلمة{i}،" for i in range(240)])
    scenes = split_script(story, 2)
    assert len(scenes) > 1
    assert sum(len(scene.split()) for scene in scenes) == len(story.split())


def test_classic_comfy_graph_converts_to_api_prompt():
    graph = {
        "nodes": [
            {
                "id": 1,
                "type": "CLIPTextEncode",
                "title": "CLIP Text Encode (Positive Prompt)",
                "inputs": [
                    {"name": "clip", "link": 10},
                    {"name": "text", "link": None, "widget": {"name": "text"}},
                ],
                "widgets_values": ["old prompt"],
                "properties": {"Node name for S&R": "CLIPTextEncode"},
            },
            {
                "id": 2,
                "type": "SaveVideo",
                "title": "Save Video",
                "inputs": [
                    {"name": "video", "link": 11},
                    {"name": "filename_prefix", "link": None, "widget": {"name": "filename_prefix"}},
                    {"name": "format", "link": None, "widget": {"name": "format"}},
                    {"name": "codec", "link": None, "widget": {"name": "codec"}},
                ],
                "widgets_values": ["video/Salah", "auto", "auto"],
                "properties": {},
            },
        ],
        "links": [[10, 9, 0, 1, 0, "CLIP"], [11, 1, 0, 2, 0, "VIDEO"]],
    }
    info = {
        "CLIPTextEncode": {"input": {"required": {"clip": ["CLIP", {}], "text": ["STRING", {}]}}},
        "SaveVideo": {"input": {"required": {"video": ["VIDEO", {}], "filename_prefix": ["STRING", {}], "format": [["auto"], {}], "codec": [["auto"], {}]}}},
    }
    converted = graph_to_api(graph, info)
    assert converted["1"]["class_type"] == "CLIPTextEncode"
    assert converted["1"]["inputs"]["clip"] == ["9", 0]
    assert converted["1"]["inputs"]["text"] == "old prompt"
    assert converted["2"]["class_type"] == "SaveVideo"


def test_patch_workflow_updates_prompt_and_seed():
    workflow = {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "old prompt", "clip": ["5", 0]},
            "_meta": {"title": "CLIP Text Encode (Positive Prompt)"},
        },
        "2": {
            "class_type": "KSampler",
            "inputs": {"seed": 1, "width": 512, "height": 512},
            "_meta": {"title": "Sampler"},
        },
    }
    req = {"aspect_ratio": "9:16", "width": 480, "height": 854, "frames": 81, "seed": 44, "visual_style": "cinematic", "character_description": ""}
    patched = patch_workflow(workflow, "a cinematic shot", req, 2, "abc123")
    assert patched["1"]["inputs"]["text"] == "a cinematic shot"
    assert patched["2"]["inputs"]["seed"] == 46
    assert patched["2"]["inputs"]["width"] == 480
    assert patched["2"]["inputs"]["height"] == 848


def test_official_wan22_blueprint_expands_to_api_prompt_and_saves_video():
    import json
    from server import ROOT, graph_to_api, ensure_video_saver, patch_workflow

    blueprint_path = ROOT / "workflows" / "wan22_t2v_blueprint.json"
    blueprint = json.loads(blueprint_path.read_text(encoding="utf-8"))
    blueprint["nodes"][0]["widgets_values"] = ["Arab historical cinematic shot", 81, 480, 848]
    subgraph = blueprint["definitions"]["subgraphs"][0]
    info = {}
    for node in subgraph["nodes"]:
        if node["type"] not in {"Note", "MarkdownNote"}:
            info[node["type"]] = {"input": {"required": {}, "optional": {}}}

    workflow = graph_to_api(blueprint, info)
    assert workflow["89"]["inputs"]["text"] == "Arab historical cinematic shot"
    assert workflow["74"]["inputs"]["length"] == 81
    assert workflow["74"]["inputs"]["width"] == 480
    assert workflow["74"]["inputs"]["height"] == 848
    assert workflow["81"]["inputs"]["steps"] == 4
    assert workflow["81"]["inputs"]["cfg"] == 1
    assert workflow["81"]["inputs"]["sampler_name"] == "euler"
    workflow = ensure_video_saver(workflow)
    saver_id = next(key for key, value in workflow.items() if value["class_type"] == "SaveVideo")
    assert workflow[saver_id]["inputs"]["video"] == ["114", 0]

    req = {"aspect_ratio": "9:16", "width": 480, "height": 848, "frames": 81, "seed": 123, "visual_style": "cinematic", "character_description": ""}
    updated = patch_workflow(workflow, "new cinematic Arabic prompt", req, 2, "job123")
    assert updated["89"]["inputs"]["text"] == "new cinematic Arabic prompt"
    assert updated[saver_id]["inputs"]["filename_prefix"].endswith("scene-003")
