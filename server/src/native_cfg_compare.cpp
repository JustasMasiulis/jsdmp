#include "native_cfg_compare.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include <glaze/glaze.hpp>

#include "triskel/triskel.hpp"

struct NativeCfgNode {
	std::string id;
	float width = 0.0F;
	float height = 0.0F;
};

struct NativeCfgEdge {
	std::string id;
	std::string from;
	std::string to;
	std::string kind;
};

struct NativeCfgPayload {
	uint32_t version = 0;
	std::string anchorAddress;
	std::vector<NativeCfgNode> nodes;
	std::vector<NativeCfgEdge> edges;
};

namespace {

struct BuiltNode {
	NativeCfgNode cfg;
	size_t native_id = 0;
};

struct BuiltEdge {
	NativeCfgEdge cfg;
	size_t native_id = 0;
};

auto parse_payload(std::string_view json_text) -> NativeCfgPayload {
	auto buffer = std::string{json_text};
	auto payload = NativeCfgPayload{};

	if (const auto ec = glz::read_json(payload, buffer)) {
		throw std::runtime_error(glz::format_error(ec, buffer));
	}

	if (payload.version != 1U) {
		throw std::runtime_error("Unsupported CFG comparison payload version");
	}

	for (const auto& node : payload.nodes) {
		if (node.id.empty()) {
			throw std::runtime_error("CFG node id must not be empty");
		}
		if (!std::isfinite(node.width) || !std::isfinite(node.height)) {
			throw std::runtime_error("CFG node dimensions must be finite");
		}
		if (node.width < 0.0F || node.height < 0.0F) {
			throw std::runtime_error("CFG node dimensions must be non-negative");
		}
	}

	for (const auto& edge : payload.edges) {
		if (edge.id.empty()) {
			throw std::runtime_error("CFG edge id must not be empty");
		}
		if (edge.from.empty() || edge.to.empty()) {
			throw std::runtime_error("CFG edges must reference source and destination nodes");
		}
	}

	return payload;
}

auto edge_type_from_kind(const std::string& kind) -> triskel::LayoutBuilder::EdgeType {
	if (kind == "true") {
		return triskel::LayoutBuilder::EdgeType::True;
	}
	if (kind == "false") {
		return triskel::LayoutBuilder::EdgeType::False;
	}
	return triskel::LayoutBuilder::EdgeType::Default;
}

auto edge_color(const std::string& kind) -> std::string_view {
	if (kind == "true") {
		return "#4caf50";
	}
	if (kind == "false") {
		return "#f44336";
	}
	return "#000000";
}

auto escape_xml(std::string_view text) -> std::string {
	auto out = std::string{};
	out.reserve(text.size());
	for (const auto ch : text) {
		switch (ch) {
			case '&':
				out += "&amp;";
				break;
			case '<':
				out += "&lt;";
				break;
			case '>':
				out += "&gt;";
				break;
			case '"':
				out += "&quot;";
				break;
			case '\'':
				out += "&apos;";
				break;
			default:
				out.push_back(ch);
				break;
		}
	}
	return out;
}

auto build_native_svg(const NativeCfgPayload& payload) -> std::string {
	if (payload.nodes.empty()) {
		throw std::runtime_error("CFG comparison payload contains no nodes");
	}

	auto builder = triskel::make_layout_builder();
	auto node_ids = std::unordered_map<std::string, size_t>{};
	auto built_nodes = std::vector<BuiltNode>{};
	auto built_edges = std::vector<BuiltEdge>{};
	built_nodes.reserve(payload.nodes.size());
	built_edges.reserve(payload.edges.size());

	for (const auto& node : payload.nodes) {
		if (!node_ids.emplace(node.id, 0).second) {
			throw std::runtime_error("Duplicate CFG node id: " + node.id);
		}
		const auto native_id =
			builder->make_node(std::max(node.height, 1.0F), std::max(node.width, 1.0F));
		node_ids[node.id] = native_id;
		built_nodes.push_back(BuiltNode{.cfg = node, .native_id = native_id});
	}

	for (const auto& edge : payload.edges) {
		const auto from_it = node_ids.find(edge.from);
		const auto to_it = node_ids.find(edge.to);
		if (from_it == node_ids.end() || to_it == node_ids.end()) {
			throw std::runtime_error("CFG edge references an unknown node");
		}

		const auto native_id =
			builder->make_edge(from_it->second, to_it->second, edge_type_from_kind(edge.kind));
		built_edges.push_back(BuiltEdge{.cfg = edge, .native_id = native_id});
	}

	auto layout = builder->build();
	const auto graph_width = std::max(layout->get_width(), 1.0F);
	const auto graph_height = std::max(layout->get_height(), 1.0F);

	auto svg = std::ostringstream{};
	svg << std::fixed << std::setprecision(2);
	svg << R"(<?xml version="1.0" encoding="UTF-8"?>)"
		<< '\n';
	svg << "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" << graph_width
		<< "\" height=\"" << graph_height << "\" viewBox=\"0 0 " << graph_width
		<< ' ' << graph_height << "\">\n";
	svg << "<title>Native Triskel CFG " << escape_xml(payload.anchorAddress)
		<< "</title>\n";
	svg << "<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>\n";
	svg << "<g fill=\"none\" stroke-linecap=\"square\" stroke-linejoin=\"miter\">\n";

	constexpr auto edge_stroke_width = 2.0F;
	constexpr auto triangle_size = 6.0F;
	for (const auto& edge : built_edges) {
		const auto& waypoints = layout->get_waypoints(edge.native_id);
		if (waypoints.empty()) {
			throw std::runtime_error("Native Triskel produced an empty waypoint list");
		}

		svg << "<polyline data-edge-id=\"" << escape_xml(edge.cfg.id) << "\" points=\"";
		for (size_t i = 0; i < waypoints.size(); ++i) {
			if (i != 0) {
				svg << ' ';
			}
			svg << waypoints[i].x << ',' << waypoints[i].y;
		}
		svg << "\" stroke=\"" << edge_color(edge.cfg.kind)
			<< "\" stroke-width=\"" << edge_stroke_width << "\"/>\n";

		const auto& tip = waypoints.back();
		svg << "<polygon data-edge-id=\"" << escape_xml(edge.cfg.id)
			<< "\" fill=\"" << edge_color(edge.cfg.kind) << "\" points=\""
			<< tip.x << ',' << tip.y << ' ' << (tip.x - triangle_size / 2.0F)
			<< ',' << (tip.y - triangle_size) << ' '
			<< (tip.x + triangle_size / 2.0F) << ',' << (tip.y - triangle_size)
			<< "\"/>\n";
	}
	svg << "</g>\n";

	constexpr auto border_stroke_width = 1.0F;

	svg << "<g>\n";
	for (const auto& node : built_nodes) {
		const auto top_left = layout->get_coords(node.native_id);
		svg << "<g data-node-id=\"" << escape_xml(node.cfg.id) << "\">\n";
		svg << "<rect x=\"" << top_left.x << "\" y=\"" << top_left.y << "\" width=\""
			<< node.cfg.width << "\" height=\"" << node.cfg.height
			<< "\" fill=\"#ffffff\" stroke=\"#d7dce2\" stroke-width=\""
			<< border_stroke_width << "\"/>\n";
		svg << "</g>\n";
	}
	svg << "</g>\n";
	svg << "</svg>\n";
	return svg.str();
}

}  // namespace

auto render_native_cfg_svg(std::string_view json_text) -> std::string {
	return build_native_svg(parse_payload(json_text));
}
