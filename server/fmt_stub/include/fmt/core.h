#pragma once

#include <cstdio>
#include <ostream>
#include <ranges>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace fmt {
namespace detail {

template <typename T>
concept StringLike =
	std::convertible_to<T, std::string_view> ||
	std::is_same_v<std::remove_cvref_t<T>, std::string>;

template <typename T>
concept HasFormatAs = requires(const T& value) {
	format_as(value);
};

template <typename T>
concept Streamable = requires(std::ostream& stream, const T& value) {
	stream << value;
};

template <typename T>
concept RangeLike = std::ranges::input_range<T> && !StringLike<T>;

template <typename T>
auto stringify(const T& value) -> std::string;

inline auto stringify(const char* value) -> std::string {
	return value == nullptr ? std::string{"(null)"} : std::string{value};
}

inline auto stringify(char* value) -> std::string {
	return value == nullptr ? std::string{"(null)"} : std::string{value};
}

template <typename T>
auto stringify_range(const T& value) -> std::string {
	auto stream = std::ostringstream{};
	stream << "[";
	auto first = true;
	for (const auto& item : value) {
		if (!first) {
			stream << ", ";
		}
		first = false;
		stream << stringify(item);
	}
	stream << "]";
	return stream.str();
}

template <typename T>
auto stringify(const T& value) -> std::string {
	if constexpr (std::is_same_v<std::remove_cvref_t<T>, bool>) {
		return value ? "true" : "false";
	} else if constexpr (std::integral<std::remove_cvref_t<T>> ||
						 std::floating_point<std::remove_cvref_t<T>>) {
		auto stream = std::ostringstream{};
		stream << value;
		return stream.str();
	} else if constexpr (StringLike<T>) {
		return std::string{std::string_view{value}};
	} else if constexpr (HasFormatAs<T>) {
		return stringify(format_as(value));
	} else if constexpr (RangeLike<T>) {
		return stringify_range(value);
	} else if constexpr (Streamable<T>) {
		auto stream = std::ostringstream{};
		stream << value;
		return stream.str();
	} else {
		return "<?>";
	}
}

inline auto render_pattern(std::string_view pattern,
						   const std::vector<std::string>& args) -> std::string {
	auto out = std::string{};
	auto arg_index = size_t{0};

	for (size_t i = 0; i < pattern.size(); ++i) {
		const auto ch = pattern[i];
		if (ch == '{') {
			if (i + 1 < pattern.size() && pattern[i + 1] == '{') {
				out.push_back('{');
				++i;
				continue;
			}

			const auto close = pattern.find('}', i + 1);
			if (close == std::string_view::npos) {
				out.push_back('{');
				continue;
			}

			if (arg_index < args.size()) {
				out += args[arg_index++];
			}
			i = close;
			continue;
		}

		if (ch == '}' && i + 1 < pattern.size() && pattern[i + 1] == '}') {
			out.push_back('}');
			++i;
			continue;
		}

		out.push_back(ch);
	}

	return out;
}

}  // namespace detail

template <typename... Args>
auto format(std::string_view pattern, Args&&... args) -> std::string {
	auto rendered_args = std::vector<std::string>{};
	rendered_args.reserve(sizeof...(Args));
	(rendered_args.push_back(detail::stringify(std::forward<Args>(args))), ...);
	return detail::render_pattern(pattern, rendered_args);
}

template <typename... Args>
void print(std::string_view pattern, Args&&... args) {
	const auto text = format(pattern, std::forward<Args>(args)...);
	std::fwrite(text.data(), 1, text.size(), stdout);
}

}  // namespace fmt
